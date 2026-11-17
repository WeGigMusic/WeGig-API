type PostHogDeletionConfig = {
  host: string;
  projectId: string;
  apiKey: string;
};

export function getPostHogDeletionConfig(): PostHogDeletionConfig {
  const host = process.env.POSTHOG_HOST?.trim().replace(/\/+$/, "");
  const projectId = process.env.POSTHOG_PROJECT_ID?.trim();
  const apiKey = process.env.POSTHOG_PERSONAL_API_KEY?.trim();

  if (
    host !== "https://eu.posthog.com" ||
    !projectId ||
    !/^\d+$/.test(projectId) ||
    !apiKey
  ) {
    throw new Error("POSTHOG_DELETION_NOT_CONFIGURED");
  }

  return { host, projectId, apiKey };
}

export async function requestPostHogDeletion(
  userId: string,
  config: PostHogDeletionConfig,
): Promise<void> {
  const response = await fetch(
    `${config.host}/api/projects/${config.projectId}/persons/bulk_delete/`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        distinct_ids: [userId],
        delete_events: true,
        delete_recordings: true,
        keep_person: false,
      }),
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    },
  );

  if (response.status !== 202) {
    throw new Error("POSTHOG_DELETION_REQUEST_FAILED");
  }

  const result = (await response.json()) as {
    persons_found?: unknown;
    persons_queued_for_deletion?: unknown;
    events_queued_for_deletion?: unknown;
    recordings_queued_for_deletion?: unknown;
    deletion_errors?: unknown;
  };

  if (
    !Number.isSafeInteger(result.persons_found) ||
    (result.persons_found as number) < 0 ||
    !Array.isArray(result.deletion_errors) ||
    result.deletion_errors.length > 0
  ) {
    throw new Error("POSTHOG_DELETION_INVALID_RESPONSE");
  }

  // No matching person is valid: analytics may never have been collected,
  // or an earlier attempt may already have removed the person.
  if (result.persons_found === 0) return;

  if (
    result.persons_queued_for_deletion !== result.persons_found ||
    result.events_queued_for_deletion !== true ||
    result.recordings_queued_for_deletion !== true
  ) {
    throw new Error("POSTHOG_DELETION_INCOMPLETE");
  }
}