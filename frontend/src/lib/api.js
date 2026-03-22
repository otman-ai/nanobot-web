// ---------------------------------------------------------------------------
// Public endpoints
// ---------------------------------------------------------------------------

export async function getOnboardingStatus() {
  const res = await fetch("/api/onboarding/status");
  if (!res.ok) throw new Error(`Onboarding status failed: ${res.status}`);
  return res.json();
}

export async function saveUserProfile(content) {
  return savePrompt("USER", content);
}

export async function completeOnboarding() {
  const res = await fetch("/api/onboarding/complete", { method: "POST" });
  if (!res.ok) throw new Error(`Onboarding complete failed: ${res.status}`);
  return res.json();
}

export async function fetchConfig() {
  const res = await fetch("/api/config");
  if (!res.ok) {
    throw new Error(`Config request failed: ${res.status}`);
  }
  return res.json();
}

export async function mergeConfig(patch) {
  const res = await fetch("/api/config", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ patch })
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Config update failed: ${res.status}`);
  }
  return res.json();
}

export async function fetchApiKeys() {
  const res = await fetch("/api/tools/api-keys");
  if (!res.ok) throw new Error(`Failed to fetch API keys: ${res.status}`);
  return res.json();
}

export async function fetchEnabledChannels() {
  const res = await fetch("/api/channels/enabled");
  if (!res.ok) throw new Error(`Failed to fetch channels: ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export async function streamChat({ message, sessionId, toolsEnabled, onEvent, signal }) {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      session_id: sessionId,
      tools_enabled: toolsEnabled
    }),
    signal
  });

  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    throw new Error(body || `Chat request failed: ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";
    for (const part of parts) {
      const line = part.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      const payload = line.replace("data: ", "");
      try {
        const event = JSON.parse(payload);
        onEvent?.(event);
      } catch (err) {
        console.warn("Failed to parse event", err);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------

export async function fetchIntegrations() {
  const res = await fetch("/api/integrations");
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Integrations request failed: ${res.status}`);
  }
  return res.json();
}

export async function saveIntegrationApiKey(apiKey) {
  const res = await fetch("/api/integrations/api-key", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey })
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Save API key failed: ${res.status}`);
  }
  return res.json();
}

export async function connectIntegration(toolkit) {
  const res = await fetch("/api/integrations/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ toolkit })
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Integration connect failed: ${res.status}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Cron
// ---------------------------------------------------------------------------

export async function fetchCronJobs({ includeDisabled = true } = {}) {
  const res = await fetch(`/api/cron/jobs?include_disabled=${includeDisabled ? "true" : "false"}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Cron jobs request failed: ${res.status}`);
  }
  return res.json();
}

export async function setCronJobEnabled(jobId, enabled) {
  const res = await fetch("/api/cron/enable", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ job_id: jobId, enabled })
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Cron enable failed: ${res.status}`);
  }
  return res.json();
}

export async function runCronJob(jobId, { force = false } = {}) {
  const res = await fetch("/api/cron/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ job_id: jobId, force })
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Cron run failed: ${res.status}`);
  }
  return res.json();
}

export async function removeCronJob(jobId) {
  const res = await fetch("/api/cron/remove", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ job_id: jobId })
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Cron remove failed: ${res.status}`);
  }
  return res.json();
}

export async function createCronJob(job) {
  const res = await fetch("/api/cron/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(job)
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Create job failed: ${res.status}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Knowledge
// ---------------------------------------------------------------------------

export async function fetchPrompt(name) {
  const res = await fetch(`/api/knowledge/prompts/${name}`);
  if (!res.ok) throw new Error(`Failed to fetch prompt ${name}: ${res.status}`);
  return res.json();
}

export async function savePrompt(name, content) {
  const res = await fetch(`/api/knowledge/prompts/${name}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content })
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Save prompt failed: ${res.status}`);
  }
  return res.json();
}

export async function fetchKnowledgeFiles() {
  const res = await fetch("/api/knowledge/files");
  if (!res.ok) throw new Error(`Failed to fetch knowledge files: ${res.status}`);
  return res.json();
}

export async function uploadKnowledgeFile(file) {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/knowledge/files", {
    method: "POST",
    body: form
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Upload failed: ${res.status}`);
  }
  return res.json();
}

export async function deleteKnowledgeFile(filename) {
  const res = await fetch(`/api/knowledge/files/${encodeURIComponent(filename)}`, {
    method: "DELETE"
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Delete failed: ${res.status}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export async function fetchMemories() {
  const res = await fetch("/api/memory");
  if (!res.ok) throw new Error(`Failed to fetch memories: ${res.status}`);
  return res.json();
}

export async function fetchMemory(filename) {
  const res = await fetch(`/api/memory/${encodeURIComponent(filename)}`);
  if (!res.ok) throw new Error(`Failed to fetch memory: ${res.status}`);
  return res.json();
}

export async function deleteMemory(filename) {
  const res = await fetch(`/api/memory/${encodeURIComponent(filename)}`, {
    method: "DELETE"
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Delete memory failed: ${res.status}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

export async function fetchSkills() {
  const res = await fetch("/api/skills");
  if (!res.ok) throw new Error(`Failed to fetch skills: ${res.status}`);
  return res.json();
}

export async function fetchSkill(name) {
  const res = await fetch(`/api/skills/${encodeURIComponent(name)}`);
  if (!res.ok) throw new Error(`Failed to fetch skill: ${res.status}`);
  return res.json();
}

export async function createSkill(name, content) {
  const res = await fetch(`/api/skills?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content })
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Create skill failed: ${res.status}`);
  }
  return res.json();
}

export async function deleteSkill(name) {
  const res = await fetch(`/api/skills/${encodeURIComponent(name)}`, {
    method: "DELETE"
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Delete skill failed: ${res.status}`);
  }
  return res.json();
}
