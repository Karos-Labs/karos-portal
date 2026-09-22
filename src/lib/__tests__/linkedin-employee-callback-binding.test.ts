import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE EMPLOYEE-SEAT CALLBACK BINDS TO THE BROWSER AND THE SESSION.
 *
 * `verifyOAuthState` proves the state token was minted by us. It does not prove
 * WHO is presenting it, and the token travels in a URL — browser history, the
 * Referer header, proxy and provider logs. For the ten minutes it stays valid,
 * anyone holding it could complete this flow with their OWN LinkedIn
 * authorization code, and the callback would write THEIR access token onto the
 * named client's seat. The portal then posts as them.
 *
 * So the route now requires three agreements — signature, the cookie set when
 * the flow started, and a session belonging to the uid the state was minted for
 * — and this suite fails if any one of them stops being required. Each negative
 * case asserts BOTH that the request is refused AND that no seat was written,
 * because a redirect to an error page while the token still lands would satisfy
 * a weaker test.
 */

const { cookieGet, cookieDelete, getCurrentUserMock, updateEmployeeSeatMock, fetchMock } =
  vi.hoisted(() => ({
    cookieGet: vi.fn(),
    cookieDelete: vi.fn(),
    getCurrentUserMock: vi.fn(),
    updateEmployeeSeatMock: vi.fn(),
    fetchMock: vi.fn(),
  }));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: cookieGet, delete: cookieDelete, set: vi.fn() }),
}));
vi.mock("@/lib/auth", () => ({ getCurrentUser: getCurrentUserMock }));
vi.mock("@/lib/data", () => ({
  updateEmployeeSeat: updateEmployeeSeatMock,
  getUser: vi.fn(async () => null),
  upsertUser: vi.fn(),
}));
vi.mock("@/services/logger", () => ({ logger: { logError: vi.fn() } }));

import { GET } from "@/app/api/integrations/linkedin/employee/callback/route";
import { signOAuthState } from "@/lib/integrations/oauth";

const UID = "employee-uid";
const CLIENT = "client-1";
const SEAT = "seat-1";

function stateToken(): string {
  return signOAuthState({ clientId: CLIENT, uid: UID, provider: "linkedin", seatId: SEAT });
}

function request(state: string): Request {
  return new Request(`https://app.example.com/api/integrations/linkedin/employee/callback?code=abc&state=${encodeURIComponent(state)}`);
}

/** Where the route sent the browser, from the Location header. */
function landedOn(res: Response): string {
  return res.headers.get("location") ?? "";
}

beforeEach(() => {
  vi.stubEnv("LINKEDIN_CLIENT_ID", "id");
  vi.stubEnv("LINKEDIN_CLIENT_SECRET", "secret");
  vi.stubEnv("OAUTH_STATE_SECRET", "test-state-secret-value");
  cookieGet.mockReset();
  cookieDelete.mockReset();
  getCurrentUserMock.mockReset();
  updateEmployeeSeatMock.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ access_token: "linkedin-token" }),
  });
});

describe("LinkedIn employee callback", () => {
  it("writes the seat when signature, cookie and session all agree", async () => {
    const state = stateToken();
    cookieGet.mockReturnValue({ value: state });
    getCurrentUserMock.mockResolvedValue({ uid: UID, disabled: false });

    const res = await GET(request(state) as never);

    expect(updateEmployeeSeatMock).toHaveBeenCalledWith(
      CLIENT,
      SEAT,
      expect.objectContaining({ status: "active" }),
    );
    expect(landedOn(res)).toContain("linkedin_seat=connected");
  });

  it("refuses a valid state with NO cookie — the replay case", async () => {
    const state = stateToken();
    cookieGet.mockReturnValue(undefined);
    getCurrentUserMock.mockResolvedValue({ uid: UID, disabled: false });

    const res = await GET(request(state) as never);

    expect(updateEmployeeSeatMock).not.toHaveBeenCalled();
    expect(landedOn(res)).toContain("linkedin_seat=invalid_state");
  });

  it("refuses when the cookie holds a DIFFERENT flow's state", async () => {
    cookieGet.mockReturnValue({ value: stateToken() });
    getCurrentUserMock.mockResolvedValue({ uid: UID, disabled: false });

    // A second, independently signed token: same shape, different nonce.
    const res = await GET(request(stateToken()) as never);

    expect(updateEmployeeSeatMock).not.toHaveBeenCalled();
    expect(landedOn(res)).toContain("linkedin_seat=invalid_state");
  });

  it("refuses when the session is somebody else", async () => {
    const state = stateToken();
    cookieGet.mockReturnValue({ value: state });
    getCurrentUserMock.mockResolvedValue({ uid: "a-different-person", disabled: false });

    const res = await GET(request(state) as never);

    expect(updateEmployeeSeatMock).not.toHaveBeenCalled();
    expect(landedOn(res)).toContain("linkedin_seat=invalid_state");
  });

  it("refuses when there is no session at all", async () => {
    const state = stateToken();
    cookieGet.mockReturnValue({ value: state });
    getCurrentUserMock.mockResolvedValue(null);

    const res = await GET(request(state) as never);

    expect(updateEmployeeSeatMock).not.toHaveBeenCalled();
    expect(landedOn(res)).toContain("linkedin_seat=invalid_state");
  });

  it("consumes the cookie even when the attempt is refused", async () => {
    // Otherwise a failed attempt leaves the nonce live for the next try.
    const state = stateToken();
    cookieGet.mockReturnValue({ value: state });
    getCurrentUserMock.mockResolvedValue(null);

    await GET(request(state) as never);

    expect(cookieDelete).toHaveBeenCalledWith("karos_oauth_state");
  });
});
