"use server";

import { revalidatePath } from "next/cache";
import { getClient } from "@/lib/data";
import { setLessonRetired, type LearnedLessons } from "@/lib/agent-engine/learning-lessons";
import { requireStaff } from "./_shared";

/**
 * Retire or restore one derived voice lesson (SCRUM-508). Staff only: the
 * lessons are the loop's own record, written partly from reviewers' internal
 * notes, and a client's say over the agent is their standing feedback.
 */
export async function setVoiceLessonRetiredAction(input: {
  clientId: string;
  lesson: string;
  retired: boolean;
}): Promise<{ error?: string; lessons?: LearnedLessons }> {
  const user = await requireStaff();
  const client = await getClient(input.clientId);
  if (!client) return { error: "Client not found." };
  const result = await setLessonRetired(client, {
    lesson: input.lesson,
    retired: input.retired,
    updatedBy: user.email ?? user.name,
  });
  if (!result.ok) return { error: result.error };
  revalidatePath(`/clients/${input.clientId}/agents`);
  return { lessons: result.lessons };
}
