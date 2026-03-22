import React, { useCallback, useEffect, useState } from "react";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";
import { Separator } from "./ui/separator";
import { Switch } from "./ui/switch";
import { Textarea } from "./ui/textarea";
import { completeOnboarding, connectIntegration, fetchIntegrations, mergeConfig, saveIntegrationApiKey, saveUserProfile } from "../lib/api";

const TOTAL_STEPS = 7;

const PROVIDER_OPTIONS = [
  { value: "auto", label: "Auto-detect" },
  { value: "openrouter", label: "OpenRouter (recommended)" },
  { value: "anthropic", label: "Anthropic" },
  { value: "openai", label: "OpenAI" },
  { value: "azure_openai", label: "Azure OpenAI" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "gemini", label: "Gemini" },
  { value: "groq", label: "Groq" },
  { value: "dashscope", label: "Dashscope (Qwen)" },
  { value: "moonshot", label: "Moonshot" },
  { value: "zhipu", label: "Zhipu GLM" },
  { value: "minimax", label: "MiniMax" },
  { value: "volcengine", label: "VolcEngine" },
  { value: "byteplus", label: "BytePlus" },
  { value: "siliconflow", label: "SiliconFlow" },
  { value: "aihubmix", label: "AiHubMix" },
  { value: "ollama", label: "Ollama (local)" },
  { value: "vllm", label: "vLLM (local)" },
  { value: "custom", label: "Custom (OpenAI-compatible)" },
];

const CHANNELS = [
  { id: "telegram", label: "Telegram", tokenField: "token", tokenLabel: "Bot token" },
  { id: "discord", label: "Discord", tokenField: "token", tokenLabel: "Bot token" },
  { id: "slack", label: "Slack", tokenField: "botToken", tokenLabel: "Bot token" },
  { id: "whatsapp", label: "WhatsApp", tokenField: "bridgeUrl", tokenLabel: "Bridge URL" },
];

const INTEGRATIONS = [
  { id: "gmail", label: "Gmail", description: "Read, send, and manage email" },
  { id: "googlecalendar", label: "Google Calendar", description: "View and create calendar events" },
  { id: "googledrive", label: "Google Drive", description: "Access and manage files in Drive" },
  { id: "outlook", label: "Outlook", description: "Email and calendar via Microsoft 365" },
  { id: "notion", label: "Notion", description: "Read and update Notion pages and databases" },
  { id: "monday", label: "Monday.com", description: "Project and task management" },
  { id: "shopify", label: "Shopify", description: "Manage your Shopify store" },
  { id: "hubspot", label: "HubSpot", description: "CRM contacts, deals, and marketing" },
];

const COMM_STYLES = ["Casual", "Professional", "Technical"];
const RESP_LENGTHS = ["Brief and concise", "Detailed explanations", "Adaptive"];
const TECH_LEVELS = ["Beginner", "Intermediate", "Expert"];

function StepIndicator({ current, total }) {
  return (
    <div className="flex items-center gap-2">
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          className={`h-2 flex-1 rounded-full transition-colors ${
            i <= current ? "bg-ink" : "bg-blunt"
          }`}
        />
      ))}
      <span className="text-xs text-smoked ml-2 whitespace-nowrap">
        Step {current + 1} of {total}
      </span>
    </div>
  );
}

function ChoiceGroup({ label, options, value, onChange }) {
  return (
    <div className="space-y-2">
      <label className="text-xs font-medium text-smoked">{label}</label>
      <div className="flex flex-wrap gap-2">
        {options.map((opt) => (
          <button
            key={opt}
            type="button"
            onClick={() => onChange(value === opt ? "" : opt)}
            className={`rounded-xl border px-3 py-1.5 text-sm transition-colors ${
              value === opt
                ? "border-ink bg-ink/10 text-ink font-medium"
                : "border-jet/10 bg-fog/50 text-ink hover:border-jet/30"
            }`}
          >
            {opt}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function OnboardingWizard({ onComplete, initialConfig }) {
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Step 0: About You
  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState("");
  const [language, setLanguage] = useState("English");

  // Step 1: Work Context
  const [commStyle, setCommStyle] = useState("");
  const [respLength, setRespLength] = useState("");
  const [techLevel, setTechLevel] = useState("");
  const [role, setRole] = useState("");
  const [projects, setProjects] = useState("");
  const [tools, setTools] = useState("");
  const [specialInstructions, setSpecialInstructions] = useState("");

  // Step 2: LLM Provider
  const [llmProvider, setLlmProvider] = useState("openrouter");
  const [llmApiKey, setLlmApiKey] = useState("");
  const [llmModel, setLlmModel] = useState("anthropic/claude-sonnet-4-6");

  // Step 3: Channels
  const [enabledChannels, setEnabledChannels] = useState({});
  const [channelTokens, setChannelTokens] = useState({});

  // Step 4: Tools
  const [braveKey, setBraveKey] = useState("");
  const [serperKey, setSerperKey] = useState("");
  const [weatherKey, setWeatherKey] = useState("");
  const [newsKey, setNewsKey] = useState("");
  const [wolframKey, setWolframKey] = useState("");

  // Step 5: Integrations
  const [composioApiKey, setComposioApiKey] = useState("");
  const [composioKeyStatus, setComposioKeyStatus] = useState({ hasKey: false, masked: "" });
  const [composioKeySaving, setComposioKeySaving] = useState(false);
  const [connectedIntegrations, setConnectedIntegrations] = useState(new Set());
  const [connectingId, setConnectingId] = useState(null);
  const [integrationError, setIntegrationError] = useState("");

  const next = () => setStep((s) => Math.min(s + 1, TOTAL_STEPS - 1));
  const back = () => setStep((s) => Math.max(s - 1, 0));

  // Load existing integration status when we reach the integrations step
  const refreshIntegrations = useCallback(async () => {
    try {
      const data = await fetchIntegrations();
      if (data?.connected) {
        setConnectedIntegrations(new Set(data.connected));
      }
      setComposioKeyStatus({ hasKey: !!data?.hasApiKey, masked: data?.maskedApiKey || "" });
    } catch {
      // Composio may not be installed — that's fine, integrations are optional
    }
  }, []);

  const handleSaveComposioKey = async () => {
    if (!composioApiKey.trim()) return;
    setComposioKeySaving(true);
    setIntegrationError("");
    try {
      await saveIntegrationApiKey(composioApiKey.trim());
      setComposioApiKey("");
      await refreshIntegrations();
    } catch (err) {
      setIntegrationError(err.message || "Failed to save API key");
    } finally {
      setComposioKeySaving(false);
    }
  };

  useEffect(() => {
    if (step === 5) {
      refreshIntegrations();
    }
  }, [step, refreshIntegrations]);

  const handleConnect = async (toolkitId) => {
    setConnectingId(toolkitId);
    setIntegrationError("");
    try {
      const result = await connectIntegration(toolkitId);
      if (result.url) {
        window.open(result.url, "_blank", "noopener,noreferrer");
      }
      if (result.status === "connected") {
        setConnectedIntegrations((prev) => new Set([...prev, toolkitId]));
      }
      // Poll a few times for the OAuth callback to complete
      let attempts = 0;
      const poll = async () => {
        attempts += 1;
        try {
          const data = await fetchIntegrations();
          if (data?.connected?.includes(toolkitId)) {
            setConnectedIntegrations(new Set(data.connected));
            return;
          }
        } catch { /* ignore */ }
        if (attempts < 8) setTimeout(poll, 3000);
      };
      setTimeout(poll, 3000);
    } catch (err) {
      setIntegrationError(err.message || "Failed to connect");
    } finally {
      setConnectingId(null);
    }
  };

  function generateUserMd() {
    const check = (val, opt) => (val === opt ? "[x]" : "[ ]");
    return [
      "# User Profile",
      "",
      "Information about the user to help personalize interactions.",
      "",
      "## Basic Information",
      "",
      `- **Name**: ${name || "(your name)"}`,
      `- **Timezone**: ${timezone || "(your timezone)"}`,
      `- **Language**: ${language || "English"}`,
      "",
      "## Preferences",
      "",
      "### Communication Style",
      "",
      `- ${check(commStyle, "Casual")} Casual`,
      `- ${check(commStyle, "Professional")} Professional`,
      `- ${check(commStyle, "Technical")} Technical`,
      "",
      "### Response Length",
      "",
      `- ${check(respLength, "Brief and concise")} Brief and concise`,
      `- ${check(respLength, "Detailed explanations")} Detailed explanations`,
      `- ${check(respLength, "Adaptive")} Adaptive based on question`,
      "",
      "### Technical Level",
      "",
      `- ${check(techLevel, "Beginner")} Beginner`,
      `- ${check(techLevel, "Intermediate")} Intermediate`,
      `- ${check(techLevel, "Expert")} Expert`,
      "",
      "## Work Context",
      "",
      `- **Primary Role**: ${role || "(your role)"}`,
      `- **Main Projects**: ${projects || "(your projects)"}`,
      `- **Tools You Use**: ${tools || "(your tools)"}`,
      "",
      "## Special Instructions",
      "",
      specialInstructions || "(Any specific instructions for how the assistant should behave)",
      "",
      "---",
      "",
      "*Edit this file to customize nanobot-web's behavior for your needs.*",
      "",
    ].join("\n");
  }

  async function handleFinish() {
    setSaving(true);
    setError("");
    try {
      // Build config patch
      const patch = {};

      const agentDefaults = {};
      if (llmModel) agentDefaults.model = llmModel;
      if (llmProvider) agentDefaults.provider = llmProvider;
      if (timezone) agentDefaults.timezone = timezone;
      patch.agents = { defaults: agentDefaults };

      // Save provider API key
      if (llmApiKey) {
        const providerName = llmProvider === "auto" ? "openrouter" : llmProvider;
        patch.providers = { [providerName]: { apiKey: llmApiKey } };
      }
      // Tool API keys
      const toolsPatch = {};
      if (braveKey) toolsPatch.web = { search: { apiKey: braveKey } };
      if (serperKey) toolsPatch.serper = { apiKey: serperKey };
      if (weatherKey) toolsPatch.weather = { apiKey: weatherKey };
      if (newsKey) toolsPatch.news = { apiKey: newsKey };
      if (wolframKey) toolsPatch.wolframAlpha = { apiKey: wolframKey };
      if (Object.keys(toolsPatch).length > 0) {
        patch.tools = toolsPatch;
      }

      // Channel config
      for (const ch of CHANNELS) {
        if (enabledChannels[ch.id]) {
          if (!patch.channels) patch.channels = {};
          patch.channels[ch.id] = {
            enabled: true,
            [ch.tokenField]: channelTokens[ch.id] || "",
          };
        }
      }

      if (Object.keys(patch).length > 0) {
        await mergeConfig(patch);
      }

      // Save USER.md
      const userMd = generateUserMd();
      await saveUserProfile(userMd);

      // Sync workspace templates (AGENTS.md, TOOLS.md, SOUL.md, etc.)
      await completeOnboarding();

      onComplete?.();
    } catch (err) {
      setError(err.message || "Failed to save settings");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col" style={{ backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)", background: "rgba(235, 237, 241, 0.75)" }}>
      {/* Fixed header with step indicator */}
      <div className="shrink-0 w-full max-w-2xl mx-auto px-6 pt-8 pb-4">
        <StepIndicator current={step} total={TOTAL_STEPS} />
      </div>

      {/* Scrollable content area */}
      <div className="flex-1 overflow-y-auto px-6 pb-4">
        <div className="w-full max-w-2xl mx-auto">
          {error && (
            <div className="mb-4 rounded-2xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          {/* Step 0: Welcome + About You */}
          {step === 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Welcome to nanobot-web!</CardTitle>
                <CardDescription>Let's set up your personal AI assistant. All fields are optional.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <div className="space-y-2">
                  <label className="text-xs font-medium text-smoked">Your name</label>
                  <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Alex" />
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-medium text-smoked">Timezone</label>
                  <Input value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="e.g. America/New_York" />
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-medium text-smoked">Preferred language</label>
                  <Input value={language} onChange={(e) => setLanguage(e.target.value)} placeholder="English" />
                </div>
              </CardContent>
            </Card>
          )}

          {/* Step 1: Work Context */}
          {step === 1 && (
            <Card>
              <CardHeader>
                <CardTitle>Work Context</CardTitle>
                <CardDescription>Help the assistant understand how you prefer to work.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <ChoiceGroup label="Communication style" options={COMM_STYLES} value={commStyle} onChange={setCommStyle} />
                <ChoiceGroup label="Response length" options={RESP_LENGTHS} value={respLength} onChange={setRespLength} />
                <ChoiceGroup label="Technical level" options={TECH_LEVELS} value={techLevel} onChange={setTechLevel} />
                <Separator />
                <div className="space-y-2">
                  <label className="text-xs font-medium text-smoked">Primary role</label>
                  <Input value={role} onChange={(e) => setRole(e.target.value)} placeholder="e.g. Full-stack developer" />
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-medium text-smoked">Main projects</label>
                  <Input value={projects} onChange={(e) => setProjects(e.target.value)} placeholder="e.g. SaaS platform, mobile app" />
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-medium text-smoked">Tools you use</label>
                  <Input value={tools} onChange={(e) => setTools(e.target.value)} placeholder="e.g. VS Code, Python, React" />
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-medium text-smoked">Special instructions</label>
                  <Textarea
                    value={specialInstructions}
                    onChange={(e) => setSpecialInstructions(e.target.value)}
                    placeholder="Any specific behavior you want from the assistant..."
                    rows={2}
                  />
                </div>
              </CardContent>
            </Card>
          )}

          {/* Step 2: LLM Provider */}
          {step === 2 && (
            <Card>
              <CardHeader>
                <CardTitle>LLM Provider</CardTitle>
                <CardDescription>Choose your AI model provider and enter your API key.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <div className="space-y-2">
                  <label className="text-xs font-medium text-smoked">Provider</label>
                  <select
                    value={llmProvider}
                    onChange={(e) => setLlmProvider(e.target.value)}
                    className="flex h-10 w-full rounded-xl border border-jet/20 bg-white px-3 py-2 text-sm text-ink shadow-sm focus:border-jet/40 focus:outline-none"
                  >
                    {PROVIDER_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                  <p className="text-xs text-smoked">
                    OpenRouter gives access to all models with a single key.{" "}
                    <a href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">Get an OpenRouter key</a>
                  </p>
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-medium text-smoked">API Key</label>
                  <Input
                    type="password"
                    value={llmApiKey}
                    onChange={(e) => setLlmApiKey(e.target.value)}
                    placeholder="Paste your API key"
                  />
                  <p className="text-xs text-smoked">
                    Not needed for local providers (Ollama, vLLM). Can also be set via environment variable.
                  </p>
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-medium text-smoked">Model ID</label>
                  <Input
                    value={llmModel}
                    onChange={(e) => setLlmModel(e.target.value)}
                    placeholder="e.g. anthropic/claude-sonnet-4-6"
                  />
                  <p className="text-xs text-smoked">
                    Full model identifier. Use provider prefix for routed models (e.g. openai/gpt-5-mini).
                  </p>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Step 3: Channels */}
          {step === 3 && (
            <Card>
              <CardHeader>
                <CardTitle>Chat Channels</CardTitle>
                <CardDescription>Connect nanobot-web to your favorite messaging platforms.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                {CHANNELS.map((ch) => (
                  <div key={ch.id} className="rounded-xl border border-jet/10 bg-fog/50 p-4">
                    <div className="flex items-center justify-between">
                      <p className="font-medium text-ink">{ch.label}</p>
                      <Switch
                        checked={!!enabledChannels[ch.id]}
                        onCheckedChange={(checked) =>
                          setEnabledChannels((prev) => ({ ...prev, [ch.id]: checked }))
                        }
                      />
                    </div>
                    {enabledChannels[ch.id] && (
                      <div className="space-y-2 mt-3">
                        <label className="text-xs font-medium text-smoked">{ch.tokenLabel}</label>
                        <Input
                          type="password"
                          value={channelTokens[ch.id] || ""}
                          onChange={(e) =>
                            setChannelTokens((prev) => ({ ...prev, [ch.id]: e.target.value }))
                          }
                          placeholder={`Enter ${ch.tokenLabel.toLowerCase()}`}
                        />
                      </div>
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {/* Step 4: Tools */}
          {step === 4 && (
            <Card>
              <CardHeader>
                <CardTitle>Tool Integrations</CardTitle>
                <CardDescription>Optional API keys for additional capabilities. You can add these later in Settings.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <div className="space-y-2">
                  <label className="text-xs font-medium text-smoked">Brave Search API key</label>
                  <Input
                    type="password"
                    value={braveKey}
                    onChange={(e) => setBraveKey(e.target.value)}
                    placeholder="BSA..."
                  />
                  <p className="text-xs text-smoked">Web search via Brave. <a href="https://brave.com/search/api/" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">Get a key</a></p>
                </div>
                <Separator />
                <div className="space-y-2">
                  <label className="text-xs font-medium text-smoked">Serper (Google Search) API key</label>
                  <Input
                    type="password"
                    value={serperKey}
                    onChange={(e) => setSerperKey(e.target.value)}
                    placeholder="..."
                  />
                  <p className="text-xs text-smoked">Google search results. <a href="https://serper.dev/" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">Get a key</a></p>
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-medium text-smoked">OpenWeatherMap API key</label>
                  <Input
                    type="password"
                    value={weatherKey}
                    onChange={(e) => setWeatherKey(e.target.value)}
                    placeholder="..."
                  />
                  <p className="text-xs text-smoked">Current weather data. <a href="https://openweathermap.org/api" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">Get a free key</a></p>
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-medium text-smoked">NewsAPI key</label>
                  <Input
                    type="password"
                    value={newsKey}
                    onChange={(e) => setNewsKey(e.target.value)}
                    placeholder="..."
                  />
                  <p className="text-xs text-smoked">News headlines and search. <a href="https://newsapi.org/" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">Get a free key</a></p>
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-medium text-smoked">Wolfram Alpha App ID</label>
                  <Input
                    type="password"
                    value={wolframKey}
                    onChange={(e) => setWolframKey(e.target.value)}
                    placeholder="..."
                  />
                  <p className="text-xs text-smoked">Math, science, and knowledge. <a href="https://developer.wolframalpha.com/" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">Get an App ID</a></p>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Step 5: Platform Integrations */}
          {step === 5 && (
            <Card>
              <CardHeader>
                <CardTitle>Platform Integrations</CardTitle>
                <CardDescription>
                  Connect external services so nanobot-web can read your email, manage your calendar, and more.
                  Integrations are powered by <a href="https://composio.dev" target="_blank" rel="noopener noreferrer" className="underline">Composio</a>.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                {integrationError && (
                  <div className="rounded-2xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
                    {integrationError}
                  </div>
                )}

                {/* Composio API Key */}
                <div className="flex flex-col gap-2">
                  <label className="text-sm font-medium text-ink">Composio API Key</label>
                  <div className="flex items-center gap-3">
                    <Input
                      type="password"
                      placeholder={composioKeyStatus.hasKey ? composioKeyStatus.masked || "Key saved" : "Enter Composio API key"}
                      value={composioApiKey}
                      onChange={(e) => setComposioApiKey(e.target.value)}
                      className="flex-1"
                    />
                    <Button
                      variant="accent"
                      size="sm"
                      disabled={composioKeySaving || !composioApiKey.trim()}
                      onClick={handleSaveComposioKey}
                    >
                      {composioKeySaving ? "Saving..." : "Save"}
                    </Button>
                  </div>
                  {composioKeyStatus.hasKey ? (
                    <p className="text-xs text-green-600">API key is configured.</p>
                  ) : (
                    <p className="text-xs text-smoked">Get your API key from <a href="https://composio.dev" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">composio.dev</a></p>
                  )}
                </div>

                <Separator />

                {/* Integration services */}
                {!composioKeyStatus.hasKey && (
                  <div className="rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-700">
                    Add your Composio API key above to connect integrations.
                  </div>
                )}
                <div className="grid gap-3 sm:grid-cols-2">
                  {INTEGRATIONS.map((ig) => {
                    const connected = connectedIntegrations.has(ig.id);
                    const connecting = connectingId === ig.id;
                    return (
                      <div
                        key={ig.id}
                        className={`rounded-xl border p-4 transition-colors ${
                          connected
                            ? "border-green-300 bg-green-50/50"
                            : "border-jet/10 bg-fog/50"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="font-medium text-ink text-sm">{ig.label}</p>
                            <p className="text-xs text-smoked mt-0.5">{ig.description}</p>
                          </div>
                          <Button
                            variant={connected ? "outline" : "accent"}
                            size="sm"
                            disabled={!composioKeyStatus.hasKey || connected || connecting}
                            onClick={() => handleConnect(ig.id)}
                            className="shrink-0"
                          >
                            {connected ? "Connected" : connecting ? "Linking..." : "Connect"}
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <p className="text-xs text-smoked mt-2">
                  You can connect more services later from the Integrations tab.
                </p>
              </CardContent>
            </Card>
          )}

          {/* Step 6: Summary */}
          {step === 6 && (
            <Card>
              <CardHeader>
                <CardTitle>All Set!</CardTitle>
                <CardDescription>Here's a summary of your configuration.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <div className="rounded-xl border border-jet/10 bg-fog/50 p-4 space-y-2 text-sm">
                  {name && <p><span className="text-smoked">Name:</span> {name}</p>}
                  {timezone && <p><span className="text-smoked">Timezone:</span> {timezone}</p>}
                  {commStyle && <p><span className="text-smoked">Style:</span> {commStyle}</p>}
                  {techLevel && <p><span className="text-smoked">Level:</span> {techLevel}</p>}
                  {role && <p><span className="text-smoked">Role:</span> {role}</p>}
                  {llmProvider && <p><span className="text-smoked">Provider:</span> {PROVIDER_OPTIONS.find((o) => o.value === llmProvider)?.label || llmProvider}</p>}
                  {llmModel && <p><span className="text-smoked">Model:</span> {llmModel}</p>}
                  {llmApiKey && <p><span className="text-smoked">API Key:</span> configured</p>}
                  {Object.entries(enabledChannels).filter(([, v]) => v).length > 0 && (
                    <p><span className="text-smoked">Channels:</span> {Object.entries(enabledChannels).filter(([, v]) => v).map(([k]) => k).join(", ")}</p>
                  )}
                  {braveKey && <p><span className="text-smoked">Brave Search:</span> configured</p>}
                  {serperKey && <p><span className="text-smoked">Serper (Google):</span> configured</p>}
                  {weatherKey && <p><span className="text-smoked">OpenWeatherMap:</span> configured</p>}
                  {newsKey && <p><span className="text-smoked">NewsAPI:</span> configured</p>}
                  {wolframKey && <p><span className="text-smoked">Wolfram Alpha:</span> configured</p>}
                  {connectedIntegrations.size > 0 && (
                    <p><span className="text-smoked">Integrations:</span> {[...connectedIntegrations].map((id) => INTEGRATIONS.find((i) => i.id === id)?.label || id).join(", ")}</p>
                  )}
                  {!name && connectedIntegrations.size === 0 && (
                    <p className="text-smoked">No settings configured yet. You can always update them later in Settings.</p>
                  )}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* Fixed footer with navigation buttons */}
      <div className="shrink-0 w-full max-w-2xl mx-auto px-6 pt-4 pb-8">
        <div className="flex justify-between items-center">
          <div>
            {step > 0 && (
              <Button variant="outline" onClick={back}>Back</Button>
            )}
          </div>
          <div className="flex gap-2">
            {step < TOTAL_STEPS - 1 && (
              <>
                <Button variant="ghost" onClick={() => onComplete?.()}>Skip all</Button>
                <Button variant="accent" onClick={next}>
                  {step === 0 ? "Get Started" : "Next"}
                </Button>
              </>
            )}
            {step === TOTAL_STEPS - 1 && (
              <Button variant="accent" onClick={handleFinish} disabled={saving}>
                {saving ? "Saving..." : "Start Chatting"}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
