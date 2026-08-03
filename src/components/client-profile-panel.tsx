"use client";

import { useEffect, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icon";
import {
  CLIENT_CATEGORY_MAX_LENGTH,
  clientCategoryLabel,
  cn,
} from "@/lib/utils";
import { BrandFavicon } from "@/components/brand-favicon";
import { SocialPlatformMark, type SocialPlatform } from "@/components/agent-identity";
import { socialAccount, socialHandleValue } from "@/lib/social-handles";
import { clientOwnerEmailAction, updateClientProfileAction } from "@/lib/actions";
import type { Client, SocialLinks } from "@/lib/types";

/**
 * The Client fields this panel renders or edits — its whole contract, stated
 * rather than implied by taking the document.
 *
 * Both shells mount it from a PROJECTION now (toClientPortalView for the client
 * rail, toStaffShellView for the staff Company sheet), and neither ships a full
 * client document to the browser. Asking for `Client` here would have forced
 * one of them to widen again just to satisfy a signature — for fields this file
 * never reads.
 *
 * THREE FIELDS LEFT THIS LIST with the inputs that edited them (CD-L P1/P2):
 * `brandVoice` (a document, not a field), `domains` (Fireflies routing, staff
 * only now) and `industry` (the tag chip's own `category` is the one that
 * stays). The projections still carry them for other readers; this panel no
 * longer touches any of the three, and a contract that says otherwise is how
 * the next person concludes it does.
 */
export type ClientProfileFields = Pick<
  Client,
  | "id"
  | "name"
  | "logoUrl"
  | "accentColor"
  | "brandingGuidelines"
  | "website"
  | "category"
  | "teamSize"
  | "brief"
  | "description"
  | "contactEmail"
  | "socialLinks"
>;

const TEAM_SIZES = ["1–10", "11–50", "51–200", "201–500", "500+"];

/**
 * The social accounts this panel shows and edits (AF-4).
 *
 * `key` doubles as the platform id for the mark and the handle parser — the
 * SocialLinks field names and `SocialPlatform` agree on all six, so a row's
 * logo, its @handle and the profile it opens all come from the same word and
 * cannot drift apart. (`website` is the seventh SocialLinks field and is not a
 * social account; it renders in the company header, not here.)
 *
 * LinkedIn earns its place beside the original three because it is the one
 * whose stored value is most often a full link — /in/ for a person, /company/
 * for a page — which is exactly the shortening AF-4 asked for.
 */
const SOCIALS: { key: keyof SocialLinks & SocialPlatform; placeholder: string }[] = [
  { key: "instagram", placeholder: "instagram handle" },
  { key: "x", placeholder: "x / twitter handle" },
  { key: "tiktok", placeholder: "tiktok handle" },
  { key: "linkedin", placeholder: "linkedin handle" },
];

/** Anything already stored for the other platforms still renders. */
const DISPLAY_SOCIALS: (keyof SocialLinks & SocialPlatform)[] = [
  "instagram",
  "x",
  "tiktok",
  "linkedin",
  "youtube",
  "facebook",
];

/** For the row's tooltip and its accessible name — the mark itself is decorative. */
const PLATFORM_NAME: Record<keyof SocialLinks & SocialPlatform, string> = {
  instagram: "Instagram",
  x: "X",
  tiktok: "TikTok",
  linkedin: "LinkedIn",
  youtube: "YouTube",
  facebook: "Facebook",
};

/**
 * ONE chip geometry for the whole meta + socials row.
 *
 * The row used to size each chip on its own and let flex stretch them to the
 * tallest, so a long category turned every handle beside it into a three-line
 * box. The Competitor Track rows a few sections down are the density this rail
 * is built at — px-2, a 14px mark, one text line — so the chips are drawn to
 * the same measurements, and the tag, the plus and the six platform logos all
 * finally draw at one size.
 */
const CHIP =
  "inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-0.5 text-xs text-muted";
const CHIP_ICON = "h-3.5 w-3.5 shrink-0 text-muted-2";

/* ── Pill-shaped input ────────────────────────────────────────────────── */

function Pill({
  icon,
  mark,
  children,
  className,
}: {
  icon?: string;
  /** A platform logo, for the rows that have one — see `SOCIALS`. */
  mark?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5 focus-within:border-neon/50",
        className,
      )}
    >
      {mark ?? <Icon name={icon ?? "AtSign"} className="h-4 w-4 shrink-0 text-muted-2" />}
      {children}
    </div>
  );
}

/* ── Brand Profile slide-in modal ─────────────────────────────────────── */

/**
 * THREE FIELDS, and the list is the whole point (CD-L P1).
 *
 * It carried six. Three of them were removed for a reason each, and none of the
 * three underlying fields was deleted:
 *
 *  • BRAND VOICE is a DOCUMENT — the Brand Voice doc in the rail below this
 *    panel, generated and versioned like the rest of them. An editable textarea
 *    here was a second source of truth for it, and the one a client would reach
 *    first. The field and the doc are untouched; this form simply no longer
 *    writes to it.
 *  • MEETING DOMAIN is Fireflies plumbing: a transcript whose attendees share
 *    this domain auto-assigns to this client. That is an ops setting with a
 *    security edge on it, not a brand fact, and it now lives in the staff Edit
 *    dialog on the Clients page (clients-grid.tsx), which is where it was
 *    already offered to staff.
 *  • INDUSTRY left because the panel's tag chip is the same idea (CD-L P2), and
 *    the chip's own field — `category` — is edited from the pencil beside this
 *    button. Two inputs for one fact is what the ruling removed.
 */
function BrandProfileModal({
  client,
  onClose,
}: {
  client: ClientProfileFields;
  onClose: () => void;
}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    contactEmail: client.contactEmail ?? "",
    website: client.website ?? "",
    description: client.description ?? "",
  });

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    document.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = prev; document.removeEventListener("keydown", onKey); };
  }, [onClose]);

  /**
   * AN UNSET CONTACT EMAIL DEFAULTS TO THE ACCOUNT OWNER'S (CD-L P1).
   *
   * Every client account has a person behind it, and on a workspace nobody has
   * filled this in for, that person's address is the answer. Resolved on the
   * SERVER — the join is users→clientId, and the panel is a "use client"
   * component, so the user collection must not cross to reach it. Asked only
   * when the field is empty, and only when the modal is open.
   *
   * A DEFAULT, not a value: it prefills the input, and Save stores it
   * explicitly. Nothing is written until somebody presses the button, so a
   * client who deletes it and saves gets an empty field rather than the owner's
   * address written back underneath them.
   */
  useEffect(() => {
    if (client.contactEmail) return;
    let live = true;
    void clientOwnerEmailAction(client.id).then(({ email }) => {
      if (!live || !email) return;
      setForm((s) => (s.contactEmail ? s : { ...s, contactEmail: email }));
    });
    return () => { live = false; };
  }, [client.id, client.contactEmail]);

  function set(k: keyof typeof form, v: string) {
    setForm((s) => ({ ...s, [k]: v }));
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await updateClientProfileAction(client.id, form);
      if (!res.ok) { setError(res.error); return; }
      onClose();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const inputCls = "w-full rounded-[8px] border border-border bg-surface-2 px-3 py-2 text-sm text-foreground placeholder:text-muted-2 outline-none focus:border-neon/50 transition-colors";
  const labelCls = "mb-1.5 block text-xs font-medium text-muted";

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex justify-end"
      style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(3px)" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="flex h-full w-full max-w-[92%] flex-col border-l border-border bg-surface shadow-2xl md:max-w-[420px]">
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-6 py-3.5">
          <div className="flex items-center gap-2">
            <Icon name="Contact" className="h-4 w-4 text-muted-2" />
            <p className="text-sm font-semibold text-foreground">Brand Profile</p>
          </div>
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-[8px] text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
            aria-label="Close"
          >
            <Icon name="X" className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={labelCls}>Contact Email</label>
              <input type="email" value={form.contactEmail} onChange={(e) => set("contactEmail", e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>Website</label>
              <input type="url" value={form.website} onChange={(e) => set("website", e.target.value)} placeholder="https://…" className={inputCls} />
            </div>
          </div>

          <div>
            <label className={labelCls}>About</label>
            <textarea
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
              placeholder="Short company description…"
              rows={3}
              className={cn(inputCls, "resize-none")}
            />
          </div>

          {error && <p className="text-xs text-danger">{error}</p>}
        </div>

        {/* Footer */}
        <div className="shrink-0 flex items-center gap-2 border-t border-border px-6 py-4">
          <button
            onClick={save}
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-[8px] bg-neon px-4 py-2 text-sm font-semibold text-[#03110b] transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            <Icon name={saving ? "Loader" : "Check"} className={cn("h-3.5 w-3.5", saving && "animate-spin")} />
            {saving ? "Saving…" : "Save"}
          </button>
          <button
            onClick={onClose}
            disabled={saving}
            className="rounded-[8px] px-4 py-2 text-sm text-muted transition-colors hover:text-foreground disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * `compact` is the height-constrained mount — the desktop client rail and the
 * staff sidebar's client-context panel, both no-scroll fixed layouts (CD-E3).
 * It tightens spacing and clamps the description to two lines, so a long
 * "about" cannot push Competitor Track and Brand Colors off the viewport. The
 * mobile Company sheet scrolls, so it mounts WITHOUT compact and keeps the
 * full text.
 *
 * It was previously never passed at any mount, so every surface rendered the
 * unbounded text and the desktop rail's no-scroll contract was decorative —
 * which is the wall of text the product owner hit in the client lens on the
 * 30 July call.
 *
 * It is also the ONLY prop left, which is the other half of this note now:
 * NO `headerAction`, AND THAT IS THE RULING (CD-L P5).
 *
 * This prop existed for one caller: the staff client-context rail passed a ↗
 * that opened the client's own website, "the extra button that is the whole
 * difference between the two views of this panel". The product owner walked
 * both views and ruled the difference out: "The rest of this page should be the
 * exact same", with Schedule and Regenerate on the DOCUMENTS heading as the
 * only staff extras anywhere in the rail.
 *
 * Staff lose nothing they cannot reach: the website is a field in the Brand
 * Profile sheet this panel's own contact button opens, and the Competitor Track
 * rows below keep their own ↗. Removing the PROP rather than the argument is
 * deliberate — a slot that exists is a slot the next divergence arrives through,
 * and with it gone the two mounts are the same expression.
 */
export function ClientProfilePanel({
  client,
  compact = false,
}: {
  client: ClientProfileFields;
  compact?: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [category, setCategory] = useState(client.category ?? "");
  const [teamSize, setTeamSize] = useState(client.teamSize ?? "");
  const [links, setLinks] = useState<SocialLinks>(client.socialLinks ?? {});
  const [brandProfileOpen, setBrandProfileOpen] = useState(false);

  function setLink(key: keyof SocialLinks, value: string) {
    setLinks((prev) => ({ ...prev, [key]: value }));
  }

  function save() {
    setError(null);
    // Shorten on the way IN, not only on the way out (AF-4): a link pasted here
    // is stored as the handle, so the field stops accumulating the five spellings
    // the display parser exists to absorb. Unparseable text is written back
    // trimmed and otherwise untouched.
    const normalized: SocialLinks = { ...links };
    for (const key of DISPLAY_SOCIALS) {
      const value = links[key];
      if (value != null) normalized[key] = socialHandleValue(key, value);
    }
    startTransition(async () => {
      const res = await updateClientProfileAction(client.id, { category, teamSize, socialLinks: normalized });
      if (res.ok) {
        setEditing(false);
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }

  // Parsed once, in the order DISPLAY_SOCIALS declares, so a row's logo, handle
  // and destination are one decision. `socialAccount` returns null only for
  // empty text, which is the same filter this line has always applied.
  const activeLinks = DISPLAY_SOCIALS.map((key) => ({
    key,
    account: socialAccount(key, client.socialLinks?.[key] ?? ""),
  })).filter((row): row is { key: SocialPlatform & keyof SocialLinks; account: NonNullable<typeof row.account> } =>
    row.account !== null,
  );
  const hasMeta = Boolean(client.category || client.teamSize);
  const inputCls =
    "min-w-0 flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-2 outline-none";

  return (
    <div className="px-1">
      {/* Company header */}
      <div className={cn("flex items-center gap-2.5", compact ? "mb-2 py-0.5" : "mb-2.5")}>
        <BrandFavicon
          src={client.logoUrl || client.brandingGuidelines?.logoUrl}
          website={client.website}
          name={client.name}
          /* The Ember accent, which is what every other brand tile in the app
             falls back to (clients-grid, Competitor Track). This one still said
             `#2dff9e` — the pre-Ember neon GREEN — so a client with no logo and
             no resolvable favicon got a green tile in the rail and an orange one
             in the clients grid, for the same account on the same screenful.
             Both mounts of this panel read the same line, so this is the
             fallback being wrong rather than the two views disagreeing. */
          accentColor={client.accentColor ?? "#ff6b2c"}
          faviconSize={64}
          /* The ternary finally decides something: the height-constrained
             mounts give the mark 28px, and the scrolling sheet keeps 32. */
          className={cn("rounded-md text-xs", compact ? "h-7 w-7" : "h-8 w-8")}
          imgClassName="border border-border bg-surface-2 object-contain"
        />
        <span className="flex-1 truncate text-sm font-semibold text-foreground">{client.name}</span>
        {!editing && (
          <div className="flex items-center gap-1">
            <button
              onClick={() => setBrandProfileOpen(true)}
              className="flex h-6 w-6 items-center justify-center rounded-md text-muted-2 transition-colors hover:bg-surface-2 hover:text-foreground"
              aria-label="Edit brand profile"
              title="Edit brand profile"
            >
              <Icon name="Contact" className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => setEditing(true)}
              className="flex h-6 w-6 items-center justify-center rounded-md text-muted-2 transition-colors hover:bg-surface-2 hover:text-foreground"
              aria-label="Edit company profile"
              title="Edit profile"
            >
              <Icon name="Pencil" className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>

      {!editing ? (
        <>
          {/* Meta + social chips — ONE wrapping row of equal-height chips.
              It was `flex-nowrap` at the rail's compact mount, on default
              align-items: stretch, and both halves of that hurt. Nothing
              shortened the category, so "Global Startup Pitch Competition"
              wrapped to three lines and squeezed its own tag icon down to a
              few pixels; stretch then pulled every handle beside it up to
              that height, which is the row of oversized boxes the product
              owner walked into on the Pitch by Deel account.
              Nowrap was there to stop a second row growing into the no-scroll
              contract (CD-E3) — but it was buying that with a row three lines
              tall, which costs the contract more than wrapping ever did.
              The chips are bounded at the SOURCE now (CD-L P3/P4): a category
              is capped where it is typed, and an account addressed by an id
              renders as its logo alone. Each chip is `shrink-0`, so a chip
              that does not fit the line moves to the next one WHOLE rather
              than being squeezed, and the ordinary case is a single 22px
              row. */}
          <div className={cn("flex flex-wrap items-center gap-1", compact ? "mb-1" : "mb-2")}>
            {hasMeta ? (
              <>
                {client.teamSize && (
                  <span className={CHIP}>
                    <Icon name="Users" className={CHIP_ICON} />
                    {client.teamSize}
                  </span>
                )}
                {client.category && (
                  /* THE CEILING IS ON THE FIELD NOW, not on this chip (CD-L P3).
                     It used to be `max-w-[9rem]` here and `max-w-[14rem]` at
                     the sheet, so the same category was cut at two different
                     words in two different views and cut mid-word in both:
                     "Global Startup Pitch Competition" read "Global Startup
                     Pit…" on the client's own profile. A chip that shortens
                     what it is showing is the wrong end of the problem, so the
                     input caps the value at a length that provably fits one
                     line at the narrower of the two mounts
                     (CLIENT_CATEGORY_MAX_LENGTH states the measurement), and
                     everything at or under that cap prints WHOLE — same text,
                     same width, both mounts. `max-w-full` is the valve for the
                     one case the cap cannot cover, a legacy or all-caps value
                     wider than its own character count suggests, and it clips
                     at the rail's edge instead of dragging in a scrollbar. */
                  <span title={client.category} className={cn(CHIP, "max-w-full")}>
                    <Icon name="Tag" className={CHIP_ICON} />
                    <span className="truncate">{clientCategoryLabel(client.category)}</span>
                  </span>
                )}
              </>
            ) : (
              <button
                onClick={() => setEditing(true)}
                className={cn(CHIP, "border-dashed text-muted-2 transition-colors hover:border-border-strong")}
              >
                <Icon name="Plus" className={CHIP_ICON} />
                Add team size &amp; category
              </button>
            )}
            {/* THE PLATFORM'S LOGO + @username, and the row opens the profile
                (AF-4). Same affordance as the brand-colour swatches beneath:
                a real control, keyboard-reachable, that does the obvious thing
                with the value it is showing.
                The mark is the one the agent surfaces and the marketing site
                use (SocialPlatformMark) — a client's Instagram row and their
                Instagram agent carry the same logo. An account whose stored
                text yields no URL still renders, as a plain chip: the handle is
                the client's own and a panel is not the place to correct it. */}
            {activeLinks.map(({ key, account }) =>
              account.url ? (
                <a
                  key={key}
                  href={account.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  /* An id has no name to read out, so the LOGO carries the
                     platform on its own (CD-L P4) — and then the accessible
                     name has to say what the row is, since the mark is
                     decorative and there is no text beside it. */
                  title={
                    account.logoOnly
                      ? PLATFORM_NAME[key]
                      : `Open ${account.handle} on ${PLATFORM_NAME[key]}`
                  }
                  aria-label={
                    account.logoOnly
                      ? `Open ${PLATFORM_NAME[key]} in a new tab`
                      : `Open ${account.handle} on ${PLATFORM_NAME[key]} in a new tab`
                  }
                  className={cn(
                    CHIP,
                    "max-w-full transition-colors hover:border-border-strong hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon",
                  )}
                >
                  <SocialPlatformMark platform={key} className="h-3.5 w-3.5 shrink-0" />
                  {!account.logoOnly && <span className="truncate">{account.handle}</span>}
                </a>
              ) : (
                <span
                  key={key}
                  title={account.logoOnly ? PLATFORM_NAME[key] : undefined}
                  aria-label={account.logoOnly ? PLATFORM_NAME[key] : undefined}
                  className={cn(CHIP, "max-w-full")}
                >
                  <SocialPlatformMark platform={key} className="h-3.5 w-3.5 shrink-0" />
                  {!account.logoOnly && <span className="truncate">{account.handle}</span>}
                </span>
              ),
            )}
          </div>

          {/* Free text of unbounded length, in a rail that must keep a
              DETERMINISTIC height (the no-scroll contract, CD-E3). Two lines
              and an ellipsis give both: the client still sees what their
              profile says, and a long "about" cannot push Competitor Track and
              Brand Colors off the viewport. The mobile Company sheet scrolls,
              so it keeps the full text. */}
          {(client.description || client.brief) && (
            <p
              className={cn(
                "text-xs leading-relaxed text-muted-2",
                compact && "line-clamp-2",
              )}
            >
              {client.description || client.brief}
            </p>
          )}
        </>
      ) : (
        /* ── Edit form (pill chips) ──
           THE ONE PLACE THE CATEGORY IS EDITED (CD-L P2). The chip above renders
           `client.category`; this input writes it. The Brand Profile sheet used
           to offer an "Industry" box beside it, which read as a second editor
           for the same fact, and it is gone — so the tag a client sees and the
           field they change are one control apart, not two forms apart. */
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1.5">
            <Pill icon="Users">
              <select
                value={teamSize}
                onChange={(e) => setTeamSize(e.target.value)}
                className="bg-transparent text-xs text-foreground outline-none [&>option]:bg-surface"
              >
                <option value="">Team</option>
                {TEAM_SIZES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </Pill>
            <Pill icon="Tag" className="flex-1">
              <input
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="Category…"
                /* The cap, where a person can feel it. The chip no longer cuts
                   the text, so this is what keeps it to one line — and the
                   helper below says why rather than letting the input just stop
                   accepting characters. */
                maxLength={CLIENT_CATEGORY_MAX_LENGTH}
                aria-describedby="client-category-hint"
                className={inputCls}
              />
            </Pill>
          </div>
          <p id="client-category-hint" className="text-[11px] text-muted-2">
            Keeps it short enough to fit your sidebar
          </p>

          {/* The same mark the row will carry once saved, so the field a person
              is typing into is labelled by the logo rather than by a generic
              @-sign repeated four times. */}
          {SOCIALS.map((s) => (
            <Pill
              key={s.key}
              mark={
                <SocialPlatformMark platform={s.key} className="h-4 w-4 shrink-0 text-muted-2" />
              }
            >
              <input
                value={links[s.key] ?? ""}
                onChange={(e) => setLink(s.key, e.target.value)}
                placeholder={s.placeholder}
                aria-label={`${PLATFORM_NAME[s.key]} handle`}
                className={inputCls}
              />
            </Pill>
          ))}

          {error && <p className="text-[11px] text-danger">{error}</p>}

          <div className="flex items-center gap-2 pt-0.5">
            <button
              onClick={save}
              disabled={pending}
              className="inline-flex items-center gap-1.5 rounded-md bg-neon px-3 py-1.5 text-xs font-semibold text-[#03110b] transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              <Icon name={pending ? "Loader" : "Check"} className={cn("h-3.5 w-3.5", pending && "animate-spin")} />
              {pending ? "Saving…" : "Save"}
            </button>
            <button
              onClick={() => {
                setEditing(false);
                setError(null);
                setCategory(client.category ?? "");
                setTeamSize(client.teamSize ?? "");
                setLinks(client.socialLinks ?? {});
              }}
              disabled={pending}
              className="rounded-md px-3 py-1.5 text-xs text-muted transition-colors hover:text-foreground disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {brandProfileOpen && (
        <BrandProfileModal client={client} onClose={() => setBrandProfileOpen(false)} />
      )}
    </div>
  );
}
