import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChatBubbleLeftRightIcon,
  CommandLineIcon,
  BookOpenIcon,
  CircleStackIcon,
  ClipboardDocumentListIcon,
  DevicePhoneMobileIcon,
  WrenchScrewdriverIcon,
  Cog6ToothIcon
} from "@heroicons/react/24/outline";
import ChatMessage from "./components/ChatMessage";
import OnboardingWizard from "./components/OnboardingWizard";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card";
import { Input } from "./components/ui/input";
import { ScrollArea } from "./components/ui/scroll-area";
import { Separator } from "./components/ui/separator";
import { Switch } from "./components/ui/switch";
import { Textarea } from "./components/ui/textarea";
import {
  connectIntegration,
  createCronJob,
  createSkill,
  deleteKnowledgeFile,
  deleteMemory,
  deleteSkill,
  fetchConfig,
  fetchIntegrations,
  fetchCronJobs,
  fetchKnowledgeFiles,
  fetchMemories,
  fetchMemory,
  fetchApiKeys,
  fetchPrompt,
  fetchSkill,
  fetchSkills,
  getOnboardingStatus,
  mergeConfig,
  removeCronJob,
  runCronJob,
  saveIntegrationApiKey,
  savePrompt,
  setCronJobEnabled,
  streamChat,
  uploadKnowledgeFile
} from "./lib/api";

const channelDefinitions = [
  {
    id: "whatsapp",
    label: "WhatsApp",
    description: "Bridge-based mode for WhatsApp. Configure the bridge URL/token and allow list.",
    fields: [
      { name: "enabled", label: "Enabled", type: "switch" },
      { name: "bridgeUrl", label: "Bridge URL", type: "text", placeholder: "ws://localhost:3001" },
      { name: "bridgeToken", label: "Bridge token", type: "text", placeholder: "(optional)" },
      {
        name: "allowFrom",
        label: "Allowed phone numbers",
        type: "textarea",
        helper: "One phone number per line (E.164 or bridge alias).",
      },
    ],
  },
  {
    id: "telegram",
    label: "Telegram",
    description: "Bot token and proxy settings for Telegram. Use allow list to restrict senders.",
    fields: [
      { name: "enabled", label: "Enabled", type: "switch" },
      { name: "token", label: "Bot token", type: "text", placeholder: "123456:ABCDEF..." },
      { name: "proxy", label: "Proxy URL", type: "text", placeholder: "http://127.0.0.1:7890" },
      { name: "replyToMessage", label: "Reply to messages", type: "switch" },
      {
        name: "groupPolicy",
        label: "Group policy",
        type: "select",
        options: [
          { value: "mention", label: "Mention only" },
          { value: "open", label: "Always reply" },
        ],
      },
      {
        name: "allowFrom",
        label: "Allowed users",
        type: "textarea",
        helper: "User IDs or usernames, one per line.",
      },
    ],
  },
];

const joinList = (value) => (Array.isArray(value) ? value.join("\n") : "");

const buildChannelFormsFromConfig = (config) => ({
  whatsapp: {
    enabled: Boolean(config?.channels?.whatsapp?.enabled),
    bridgeUrl: config?.channels?.whatsapp?.bridgeUrl ?? "",
    bridgeToken: config?.channels?.whatsapp?.bridgeToken ?? "",
    allowFrom: joinList(config?.channels?.whatsapp?.allowFrom ?? []),
  },
  telegram: {
    enabled: Boolean(config?.channels?.telegram?.enabled),
    token: config?.channels?.telegram?.token ?? "",
    proxy: config?.channels?.telegram?.proxy ?? "",
    replyToMessage: Boolean(config?.channels?.telegram?.replyToMessage),
    groupPolicy: config?.channels?.telegram?.groupPolicy ?? "mention",
    allowFrom: joinList(config?.channels?.telegram?.allowFrom ?? []),
  },
});

const parseListInput = (raw) =>
  (raw || "")
    .split(/[\n,]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

const TOOL_DEFAULTS = {
  files: true,
  exec: false,
  web: true,
  services: true,
  integrations: true,
  message: true,
  spawn: false,
  cron: false,
  mcp: true
};

const toolLabels = {
  files: "File Tools",
  exec: "Shell Exec",
  web: "Web Tools",
  services: "Services",
  integrations: "Integrations",
  message: "Message",
  spawn: "Spawn",
  cron: "Cron",
  mcp: "MCP"
};

const storageKey = {
  sessions: "nanobot-web.sessions",
  tools: "nanobot-web.tools",
  session: "nanobot-web.session"
};

function timestamp() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function App() {
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [messages, setMessages] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [toolsEnabled, setToolsEnabled] = useState(TOOL_DEFAULTS);
  const [toolsLoaded, setToolsLoaded] = useState(false);
  const [activeSection, setActiveSection] = useState("Chat");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [config, setConfig] = useState(null);
  const [configError, setConfigError] = useState("");
  const [status, setStatus] = useState("");
  const [patchText, setPatchText] = useState("{}");
  const [integrations, setIntegrations] = useState({ toolkits: [], connected: [], hasApiKey: false, maskedApiKey: "" });
  const [integrationsError, setIntegrationsError] = useState("");
  const [composioKeyInput, setComposioKeyInput] = useState("");
  const [composioKeySaving, setComposioKeySaving] = useState(false);
  const [apiKeyTools, setApiKeyTools] = useState([]);
  const [apiKeyInputs, setApiKeyInputs] = useState({});
  const [apiKeySaving, setApiKeySaving] = useState(null);
  const [connecting, setConnecting] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [tasksStatus, setTasksStatus] = useState(null);
  const [tasksError, setTasksError] = useState("");
  const [tasksLoading, setTasksLoading] = useState(false);
  const [taskActions, setTaskActions] = useState({});
  const [taskCreating, setTaskCreating] = useState(false);
  const [taskForm, setTaskForm] = useState({
    name: "",
    schedule_kind: "every",
    every_minutes: "30",
    cron_expr: "",
    cron_tz: "",
    at_datetime: "",
    message: "",
    deliver: false,
    channel: "",
    to: "",
    delete_after_run: false,
  });
  const [channelForms, setChannelForms] = useState(() => buildChannelFormsFromConfig(null));
  const [channelSaving, setChannelSaving] = useState({});
  const [channelErrors, setChannelErrors] = useState({});

  // Knowledge state
  const [knowledgePrompts, setKnowledgePrompts] = useState({ USER: "", SOUL: "" });
  const [knowledgeEditing, setKnowledgeEditing] = useState(null); // "USER" | "SOUL" | null
  const [knowledgeEditText, setKnowledgeEditText] = useState("");
  const [knowledgeSaving, setKnowledgeSaving] = useState(false);
  const [knowledgeFiles, setKnowledgeFiles] = useState([]);
  const [knowledgeUploading, setKnowledgeUploading] = useState(false);
  const [knowledgeError, setKnowledgeError] = useState("");
  const knowledgeFileRef = useRef(null);

  // Memory state
  const [memories, setMemories] = useState([]);
  const [memoryReading, setMemoryReading] = useState(null); // filename being read
  const [memoryContent, setMemoryContent] = useState("");
  const [memoryError, setMemoryError] = useState("");

  // Skills state
  const [skills, setSkills] = useState([]);
  const [skillReading, setSkillReading] = useState(null);
  const [skillContent, setSkillContent] = useState("");
  const [skillCreating, setSkillCreating] = useState(false);
  const [newSkillName, setNewSkillName] = useState("");
  const [newSkillContent, setNewSkillContent] = useState("");
  const [skillError, setSkillError] = useState("");

  const controllerRef = useRef(null);
  const scrollViewportRef = useRef(null);
  const sessionIdRef = useRef("web:" + Math.random().toString(36).slice(2));
  const messageOrderRef = useRef(0);

  const nextOrder = () => {
    messageOrderRef.current += 1;
    return messageOrderRef.current;
  };

  const [form, setForm] = useState({
    model: "",
    provider: "auto",
    providerApiKey: "",
    temperature: "0.1",
    maxTokens: "8192",
    contextWindowTokens: "65536",
    timezone: ""
  });

  const navItems = [
    { label: "Chat", icon: ChatBubbleLeftRightIcon },
    { label: "Integrations", icon: CommandLineIcon },
    { label: "Channels", icon: DevicePhoneMobileIcon },
    { label: "Knowledge", icon: BookOpenIcon },
    { label: "Memory", icon: CircleStackIcon },
    { label: "Tasks", icon: ClipboardDocumentListIcon },
    { label: "Skills", icon: WrenchScrewdriverIcon },
    { label: "Settings", icon: Cog6ToothIcon }
  ];


  useEffect(() => {
    const savedSessions = localStorage.getItem(storageKey.sessions);
    const savedSessionId = localStorage.getItem(storageKey.session);
    if (savedSessions) {
      const parsed = JSON.parse(savedSessions);
      setSessions(parsed);
      const active = parsed.find((s) => s.id === savedSessionId) || parsed[0];
      if (active) {
        sessionIdRef.current = active.id;
        setMessages(active.messages || []);
        messageOrderRef.current = (active.messages || []).reduce(
          (max, msg) => Math.max(max, Number(msg.createdAt) || 0),
          0
        );
      }
    } else {
      const initial = {
        id: sessionIdRef.current,
        title: "New chat",
        createdAt: Date.now(),
        messages: []
      };
      setSessions([initial]);
      localStorage.setItem(storageKey.sessions, JSON.stringify([initial]));
      localStorage.setItem(storageKey.session, initial.id);
    }
    const savedTools = localStorage.getItem(storageKey.tools);
    if (savedTools) {
      try {
        setToolsEnabled({ ...TOOL_DEFAULTS, ...JSON.parse(savedTools) });
      } catch {
        setToolsEnabled(TOOL_DEFAULTS);
      }
    }
    setToolsLoaded(true);
  }, []);

  useEffect(() => {
    setSessions((prev) => {
      const next = prev.map((session) =>
        session.id === sessionIdRef.current
          ? { ...session, messages }
          : session
      );
      localStorage.setItem(storageKey.sessions, JSON.stringify(next));
      return next;
    });
  }, [messages]);

  useEffect(() => {
    if (!toolsLoaded) return;
    localStorage.setItem(storageKey.tools, JSON.stringify(toolsEnabled));
  }, [toolsEnabled, toolsLoaded]);

  const updateToolsEnabled = (updater) => {
    setToolsEnabled((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      localStorage.setItem(storageKey.tools, JSON.stringify(next));
      setToolsLoaded(true);
      return next;
    });
  };

  const enabledList = useMemo(() => {
    return Object.entries(toolsEnabled)
      .filter(([, value]) => value)
      .map(([key]) => key);
  }, [toolsEnabled]);

  const orderedMessages = useMemo(() => {
    return [...messages].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  }, [messages]);

  useEffect(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport) return;
    viewport.scrollTop = viewport.scrollHeight;
  }, [orderedMessages, streaming]);

  const loadConfig = useCallback(async () => {
    setConfigError("");
    try {
      const data = await fetchConfig();
      setConfig(data.config);
      const defaults = data.config?.agents?.defaults ?? {};
      // Detect which provider has an API key set
      const providerName = defaults.provider || "auto";
      const providers = data.config?.providers ?? {};
      // Find the active provider's masked key (we don't expose full keys)
      let activeProviderKey = "";
      if (providerName !== "auto") {
        const p = providers[providerName];
        if (p?.apiKey) activeProviderKey = p.apiKey.slice(0, 4) + "..." + p.apiKey.slice(-4);
      } else {
        // Find first provider with a key
        for (const [, p] of Object.entries(providers)) {
          if (p?.apiKey) {
            activeProviderKey = p.apiKey.slice(0, 4) + "..." + p.apiKey.slice(-4);
            break;
          }
        }
      }
      setForm({
        model: defaults.model || "",
        provider: providerName,
        providerApiKey: "",
        temperature: String(defaults.temperature ?? "0.1"),
        maxTokens: String(defaults.maxTokens ?? "8192"),
        contextWindowTokens: String(defaults.contextWindowTokens ?? "65536"),
        timezone: defaults.timezone || "",
        _maskedKey: activeProviderKey
      });
    } catch (err) {
      setConfigError(err.message || "Failed to load config");
    }
  }, []);

  useEffect(() => {
    loadConfig();
    // Check if onboarding is needed on first load
    getOnboardingStatus()
      .then((data) => {
        if (data.needs_onboarding) setShowOnboarding(true);
      })
      .catch(() => {}); // Ignore errors (e.g. server not ready)
  }, [loadConfig]);

  useEffect(() => {
    if (config) {
      setChannelForms(buildChannelFormsFromConfig(config));
    }
  }, [config]);

  const loadApiKeys = useCallback(async () => {
    try {
      const data = await fetchApiKeys();
      setApiKeyTools(data.tools || []);
    } catch { /* API keys endpoint optional */ }
  }, []);

  const loadIntegrations = useCallback(async () => {
    setIntegrationsError("");
    try {
      const data = await fetchIntegrations();
      setIntegrations(data);
      return data;
    } catch (err) {
      setIntegrationsError(err.message || "Failed to load integrations");
    }
    return null;
  }, []);

  useEffect(() => {
    if (activeSection === "Integrations") {
      loadIntegrations();
    }
    if (activeSection === "Settings") {
      loadApiKeys();
    }
  }, [activeSection, loadIntegrations, loadApiKeys]);

  const loadTasks = useCallback(async () => {
    setTasksError("");
    setTasksLoading(true);
    try {
      const data = await fetchCronJobs({ includeDisabled: true });
      setTasks(data.jobs || []);
      setTasksStatus(data.status || null);
    } catch (err) {
      setTasksError(err.message || "Failed to load tasks");
    } finally {
      setTasksLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeSection === "Tasks") {
      loadTasks();
    }
  }, [activeSection, loadTasks]);

  // --- Knowledge loaders ---
  const loadKnowledgePrompts = useCallback(async () => {
    setKnowledgeError("");
    try {
      const [user, soul] = await Promise.all([
        fetchPrompt("USER"),
        fetchPrompt("SOUL"),
      ]);
      setKnowledgePrompts({ USER: user.content, SOUL: soul.content });
    } catch (err) {
      setKnowledgeError(err.message);
    }
  }, []);

  const loadKnowledgeFiles = useCallback(async () => {
    try {
      const data = await fetchKnowledgeFiles();
      setKnowledgeFiles(data.files || []);
    } catch (err) {
      setKnowledgeError(err.message);
    }
  }, []);

  useEffect(() => {
    if (activeSection === "Knowledge") {
      loadKnowledgePrompts();
      loadKnowledgeFiles();
    }
  }, [activeSection, loadKnowledgePrompts, loadKnowledgeFiles]);

  const handleSavePrompt = async (name) => {
    setKnowledgeSaving(true);
    setKnowledgeError("");
    try {
      await savePrompt(name, knowledgeEditText);
      setKnowledgePrompts((prev) => ({ ...prev, [name]: knowledgeEditText }));
      setKnowledgeEditing(null);
    } catch (err) {
      setKnowledgeError(err.message);
    } finally {
      setKnowledgeSaving(false);
    }
  };

  const handleUploadKnowledge = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setKnowledgeUploading(true);
    setKnowledgeError("");
    try {
      await uploadKnowledgeFile(file);
      await loadKnowledgeFiles();
    } catch (err) {
      setKnowledgeError(err.message);
    } finally {
      setKnowledgeUploading(false);
      if (knowledgeFileRef.current) knowledgeFileRef.current.value = "";
    }
  };

  const handleDeleteKnowledgeFile = async (filename) => {
    setKnowledgeError("");
    try {
      await deleteKnowledgeFile(filename);
      setKnowledgeFiles((prev) => prev.filter((f) => f.name !== filename));
    } catch (err) {
      setKnowledgeError(err.message);
    }
  };

  // --- Memory loaders ---
  const loadMemories = useCallback(async () => {
    setMemoryError("");
    try {
      const data = await fetchMemories();
      setMemories(data.entries || []);
    } catch (err) {
      setMemoryError(err.message);
    }
  }, []);

  useEffect(() => {
    if (activeSection === "Memory") {
      loadMemories();
    }
  }, [activeSection, loadMemories]);

  const handleReadMemory = async (filename) => {
    if (memoryReading === filename) {
      setMemoryReading(null);
      setMemoryContent("");
      return;
    }
    setMemoryError("");
    try {
      const data = await fetchMemory(filename);
      setMemoryReading(filename);
      setMemoryContent(data.content);
    } catch (err) {
      setMemoryError(err.message);
    }
  };

  const handleDeleteMemory = async (filename) => {
    setMemoryError("");
    try {
      await deleteMemory(filename);
      setMemories((prev) => prev.filter((m) => m.filename !== filename));
      if (memoryReading === filename) {
        setMemoryReading(null);
        setMemoryContent("");
      }
    } catch (err) {
      setMemoryError(err.message);
    }
  };

  // --- Skills loaders ---
  const loadSkills = useCallback(async () => {
    setSkillError("");
    try {
      const data = await fetchSkills();
      setSkills(data.skills || []);
    } catch (err) {
      setSkillError(err.message);
    }
  }, []);

  useEffect(() => {
    if (activeSection === "Skills") {
      loadSkills();
    }
  }, [activeSection, loadSkills]);

  const handleReadSkill = async (name) => {
    if (skillReading === name) {
      setSkillReading(null);
      setSkillContent("");
      return;
    }
    setSkillError("");
    try {
      const d = await fetchSkill(name);
      setSkillReading(name);
      setSkillContent(d.content);
    } catch (err) {
      setSkillError(err.message);
    }
  };

  const handleCreateSkill = async () => {
    if (!newSkillName.trim() || !newSkillContent.trim()) return;
    setSkillError("");
    try {
      await createSkill(newSkillName.trim(), newSkillContent.trim());
      setSkillCreating(false);
      setNewSkillName("");
      setNewSkillContent("");
      await loadSkills();
    } catch (err) {
      setSkillError(err.message);
    }
  };

  const handleDeleteSkill = async (name) => {
    setSkillError("");
    try {
      await deleteSkill(name);
      setSkills((prev) => prev.filter((s) => s.name !== name));
      if (skillReading === name) {
        setSkillReading(null);
        setSkillContent("");
      }
    } catch (err) {
      setSkillError(err.message);
    }
  };

  const handleSend = async () => {
    if (!input.trim() || streaming) return;

    const messageId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();

    setMessages((prev) => [
      ...prev,
      {
        id: messageId,
        role: "user",
        content: input.trim(),
        timestamp: timestamp(),
        createdAt: nextOrder()
      },
      {
        id: assistantId,
        role: "assistant",
        content: "",
        timestamp: timestamp(),
        createdAt: nextOrder()
      }
    ]);

    setInput("");
    setStreaming(true);
    setStatus("Streaming response...");

    controllerRef.current = new AbortController();

    try {
      await streamChat({
        message: input.trim(),
        sessionId: sessionIdRef.current,
        toolsEnabled: enabledList,
        signal: controllerRef.current.signal,
        onEvent: (event) => {
          if (event.type === "delta") {
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === assistantId
                  ? { ...msg, content: msg.content + event.content }
                  : msg
              )
            );
          }
          if (event.type === "progress") {
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === assistantId
                  ? {
                      ...msg,
                      meta: {
                        ...msg.meta,
                        flow: [
                          ...(msg.meta?.flow || []),
                          { type: "thought", content: event.content }
                        ]
                      }
                    }
                  : msg
              )
            );
          }
          if (event.type === "tool_hint") {
            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === assistantId
                  ? {
                      ...msg,
                      meta: {
                        ...msg.meta,
                        flow: [
                          ...(msg.meta?.flow || []),
                          { type: "tool", content: event.content }
                        ]
                      }
                    }
                  : msg
              )
            );
          }
          if (event.type === "error") {
            setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "error",
                content: event.content,
                timestamp: timestamp(),
                createdAt: nextOrder()
              }
            ]);
          }
          if (event.type === "done") {
            setStreaming(false);
            setStatus("");
          }
        }
      });
    } catch (err) {
      setStreaming(false);
      setStatus("");
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "error",
          content: err.message || "Chat request failed",
          timestamp: timestamp(),
          createdAt: nextOrder()
        }
      ]);
    }
  };

  const formatDateTime = (ms) => {
    if (!ms) return "—";
    return new Date(ms).toLocaleString();
  };

  const formatDuration = (ms) => {
    if (!ms || ms <= 0) return "—";
    const units = [
      { label: "day", ms: 86400000 },
      { label: "hour", ms: 3600000 },
      { label: "min", ms: 60000 },
      { label: "sec", ms: 1000 }
    ];
    for (const unit of units) {
      const value = Math.floor(ms / unit.ms);
      if (value >= 1) {
        return `${value} ${unit.label}${value === 1 ? "" : "s"}`;
      }
    }
    return "0 sec";
  };

  const formatSchedule = (job) => {
    if (!job?.schedule) return "—";
    if (job.schedule.kind === "every") {
      return `Every ${formatDuration(job.schedule.everyMs)}`;
    }
    if (job.schedule.kind === "cron") {
      return job.schedule.tz
        ? `Cron ${job.schedule.expr} (${job.schedule.tz})`
        : `Cron ${job.schedule.expr}`;
    }
    if (job.schedule.kind === "at") {
      return `At ${formatDateTime(job.schedule.atMs)}`;
    }
    return "—";
  };

  const handleChannelFieldChange = (channelId, field, value) => {
    setChannelForms((prev) => ({
      ...prev,
      [channelId]: {
        ...prev[channelId],
        [field]: value,
      },
    }));
  };

  const handleTaskToggle = async (jobId, enabled) => {
    setTaskActions((prev) => ({ ...prev, [jobId]: "toggle" }));
    try {
      const data = await setCronJobEnabled(jobId, enabled);
      if (data.job) {
        setTasks((prev) => prev.map((item) => (item.id === jobId ? data.job : item)));
      }
    } catch (err) {
      setTasksError(err.message || "Failed to update task");
    } finally {
      setTaskActions((prev) => {
        const next = { ...prev };
        delete next[jobId];
        return next;
      });
    }
  };

  const handleTaskRun = async (job) => {
    setTaskActions((prev) => ({ ...prev, [job.id]: "run" }));
    try {
      const data = await runCronJob(job.id, { force: !job.enabled });
      if (data.removed) {
        setTasks((prev) => prev.filter((item) => item.id !== job.id));
      } else if (data.job) {
        setTasks((prev) => prev.map((item) => (item.id === job.id ? data.job : item)));
      }
    } catch (err) {
      setTasksError(err.message || "Failed to run task");
    } finally {
      setTaskActions((prev) => {
        const next = { ...prev };
        delete next[job.id];
        return next;
      });
    }
  };

  const handleTaskRemove = async (jobId) => {
    setTaskActions((prev) => ({ ...prev, [jobId]: "remove" }));
    try {
      await removeCronJob(jobId);
      setTasks((prev) => prev.filter((item) => item.id !== jobId));
    } catch (err) {
      setTasksError(err.message || "Failed to remove task");
    } finally {
      setTaskActions((prev) => {
        const next = { ...prev };
        delete next[jobId];
        return next;
      });
    }
  };

  const handleCreateTask = async () => {
    setTasksError("");
    try {
      const payload = {
        name: taskForm.name,
        schedule_kind: taskForm.schedule_kind,
        message: taskForm.message,
        deliver: taskForm.deliver,
        delete_after_run: taskForm.delete_after_run,
      };
      if (taskForm.schedule_kind === "every") {
        payload.every_minutes = parseInt(taskForm.every_minutes, 10) || 30;
      } else if (taskForm.schedule_kind === "cron") {
        payload.cron_expr = taskForm.cron_expr;
        payload.cron_tz = taskForm.cron_tz || undefined;
      } else if (taskForm.schedule_kind === "at") {
        payload.at_datetime = taskForm.at_datetime;
      }
      if (taskForm.deliver) {
        payload.channel = taskForm.channel || undefined;
        payload.to = taskForm.to || undefined;
      }
      await createCronJob(payload);
      setTaskCreating(false);
      setTaskForm({
        name: "", schedule_kind: "every", every_minutes: "30", cron_expr: "",
        cron_tz: "", at_datetime: "", message: "", deliver: false,
        channel: "", to: "", delete_after_run: false,
      });
      await loadTasks();
    } catch (err) {
      setTasksError(err.message || "Failed to create task");
    }
  };

  const handleSaveChannel = async (channelId) => {
    const values = channelForms[channelId];
    if (!values) return;
    const payload = {
      ...values,
      allowFrom: parseListInput(values.allowFrom),
    };
    setChannelSaving((prev) => ({ ...prev, [channelId]: true }));
    setChannelErrors((prev) => ({ ...prev, [channelId]: "" }));
    try {
      await mergeConfig({
        channels: {
          [channelId]: payload,
        },
      });
      await loadConfig();
    } catch (err) {
      setChannelErrors((prev) => ({
        ...prev,
        [channelId]: err.message || "Failed to save channel",
      }));
    } finally {
      setChannelSaving((prev) => ({ ...prev, [channelId]: false }));
    }
  };

  const handleStop = () => {
    controllerRef.current?.abort();
    setStreaming(false);
    setStatus("Stopped");
  };

  const handleClear = () => {
    setMessages([]);
    setStatus("");
  };

  const handleNewChat = () => {
    const id = "web:" + Math.random().toString(36).slice(2);
    const newSession = {
      id,
      title: `Chat ${sessions.length + 1}`,
      createdAt: Date.now(),
      messages: []
    };
    const nextSessions = [newSession, ...sessions];
    setSessions(nextSessions);
    localStorage.setItem(storageKey.sessions, JSON.stringify(nextSessions));
    localStorage.setItem(storageKey.session, id);
    sessionIdRef.current = id;
    messageOrderRef.current = 0;
    setMessages([]);
  };

  const handleSwitchSession = (id) => {
    const target = sessions.find((s) => s.id === id);
    if (!target) return;
    sessionIdRef.current = id;
    localStorage.setItem(storageKey.session, id);
    setMessages(target.messages || []);
    messageOrderRef.current = (target.messages || []).reduce(
      (max, msg) => Math.max(max, Number(msg.createdAt) || 0),
      0
    );
  };

  const handleSaveConfig = async () => {
    setStatus("Updating config...");
    try {
      const patch = {
        agents: {
          defaults: {
            model: form.model,
            provider: form.provider,
            temperature: Number(form.temperature),
            maxTokens: Number(form.maxTokens),
            contextWindowTokens: Number(form.contextWindowTokens),
            timezone: form.timezone
          }
        }
      };
      // Only update the provider API key if the user entered a new one
      if (form.providerApiKey) {
        const providerName = form.provider === "auto" ? "openrouter" : form.provider;
        patch.providers = { [providerName]: { apiKey: form.providerApiKey } };
      }
      await mergeConfig(patch);
      await loadConfig();
      setStatus("Config updated");
    } catch (err) {
      setStatus("");
      setConfigError(err.message || "Config update failed");
    }
  };

  const handlePatch = async () => {
    setStatus("Applying patch...");
    try {
      const patch = JSON.parse(patchText || "{}");
      await mergeConfig(patch);
      await loadConfig();
      setStatus("Patch applied");
    } catch (err) {
      setStatus("");
      setConfigError(err.message || "Patch failed");
    }
  };

  const handleSaveComposioKey = async () => {
    if (!composioKeyInput.trim()) return;
    setComposioKeySaving(true);
    setIntegrationsError("");
    try {
      await saveIntegrationApiKey(composioKeyInput.trim());
      setComposioKeyInput("");
      await loadIntegrations();
    } catch (err) {
      setIntegrationsError(err.message || "Failed to save API key");
    } finally {
      setComposioKeySaving(false);
    }
  };

  const handleConnectIntegration = async (toolkit) => {
    setConnecting(toolkit);
    try {
      const result = await connectIntegration(toolkit);
      if (result.url) {
        window.open(result.url, "_blank", "noopener,noreferrer");
      }
      if (result.status === "connected") {
        setIntegrations((prev) => ({
          ...prev,
          connected: Array.from(new Set([...(prev.connected || []), toolkit]))
        }));
      }
      await loadIntegrations();
      let attempts = 0;
      const poll = async () => {
        attempts += 1;
        const data = await loadIntegrations();
        const isConnected = (data?.connected || []).includes(toolkit);
        if (isConnected || attempts >= 10) {
          return;
        }
        setTimeout(poll, 3000);
      };
      setTimeout(poll, 3000);
    } catch (err) {
      setIntegrationsError(err.message || "Failed to connect integration");
    } finally {
      setConnecting(null);
    }
  };

  return (
    <div className="h-screen w-full px-6 py-6 overflow-hidden">
      <div className="flex h-full w-full gap-6">
        <aside
          className={`flex h-full flex-col justify-between rounded-3xl border border-jet/10 bg-fog/90 p-4 transition-all ${sidebarOpen ? "w-64" : "w-20"}`}
        >
          <div className="flex flex-col gap-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-ink text-fog">nb</div>
                {sidebarOpen && (
                  <div>
                    <p className="text-xs uppercase tracking-[0.2em] text-smoked">nanobot</p>
                    <p className="font-display text-lg text-ink">Control</p>
                  </div>
                )}
              </div>
              <Button variant="ghost" size="sm" onClick={() => setSidebarOpen((prev) => !prev)}>
                {sidebarOpen ? "⟨" : "⟩"}
              </Button>
            </div>

            <nav className="flex flex-col gap-2">
              {navItems.map((item) => (
                <button
                  key={item.label}
                  onClick={() => setActiveSection(item.label)}
                  className={`flex items-center gap-3 rounded-2xl px-3 py-2 text-sm font-medium transition ${
                    activeSection === item.label ? "bg-ink text-fog" : "text-ink hover:bg-blunt/60"
                  }`}
                >
                  <span className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-fog/80 text-sm text-smoked">
                    <item.icon className="h-4 w-4" />
                  </span>
                  {sidebarOpen && <span>{item.label}</span>}
                </button>
              ))}
            </nav>
          </div>

        </aside>

        <main className="flex flex-1 flex-col overflow-hidden">
          <div className="flex-1 overflow-hidden">

            {activeSection === "Chat" && (
              <div className="grid h-full gap-6">
              <Card className="flex h-full min-h-0 flex-col">
                <CardHeader className="space-y-2">
                  <CardTitle>Chat</CardTitle>
                  <CardDescription>History lives in your browser. Streaming updates show tool hints and output.</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-1 min-h-0 flex-col gap-4 overflow-hidden">
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="outline" size="sm" onClick={handleNewChat}>New chat</Button>
                    <div className="flex flex-wrap gap-2">
                      {sessions.slice(0, 6).map((session) => (
                        <button
                          key={session.id}
                          onClick={() => handleSwitchSession(session.id)}
                          className={`rounded-full border px-3 py-1 text-xs transition ${
                            session.id === sessionIdRef.current
                              ? "border-ink bg-ink text-fog"
                              : "border-jet/20 bg-fog/70 text-ink hover:bg-blunt/60"
                          }`}
                        >
                          {session.title}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="min-h-0 flex-1">
                    <ScrollArea className="h-full rounded-2xl border border-jet/10 bg-fog/70 p-4" viewportRef={scrollViewportRef}>
                      <div className="flex flex-col gap-6">
                        {messages.length === 0 && (
                          <div className="rounded-2xl border border-dashed border-jet/20 p-6 text-sm text-smoked">
                            No messages yet. Start a conversation.
                          </div>
                        )}
                        {orderedMessages.map((msg) => (
                          <ChatMessage key={msg.id} {...msg} />
                        ))}
                        {streaming && (
                          <div className="flex items-center gap-3 text-sm text-smoked">
                            <span className="inline-flex h-2.5 w-2.5 animate-pulse rounded-full bg-ink" />
                            nanobot is generating...
                          </div>
                        )}
                      </div>
                    </ScrollArea>
                  </div>

                  <div className="flex shrink-0 flex-col gap-3">
                    <Textarea
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onInput={(e) => {
                        const el = e.currentTarget;
                        el.style.height = "auto";
                        el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
                      }}
                      rows={2}
                      className="min-h-[48px] max-h-[180px] resize-none"
                      placeholder="Ask nanobot anything..."
                    />
                    <div className="flex flex-wrap gap-2">
                      <Button onClick={handleSend} disabled={streaming}>Send</Button>
                      <Button variant="outline" onClick={handleStop} disabled={!streaming}>Stop</Button>
                      <Button variant="ghost" onClick={handleClear}>Clear</Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
              </div>
            )}

            {activeSection === "Settings" && (
              <div className="h-full overflow-y-auto pr-2">
                <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
              <Card>
                <CardHeader>
                  <CardTitle>Tools</CardTitle>
                  <CardDescription>Toggle what the agent can use this session.</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                  {Object.keys(TOOL_DEFAULTS).map((tool) => (
                    <div key={tool} className="flex items-center justify-between rounded-2xl border border-jet/10 bg-fog/70 px-4 py-3">
                      <div>
                        <p className="font-medium text-ink">{toolLabels[tool]}</p>
                        <p className="text-xs text-smoked">{tool}</p>
                      </div>
                        <Switch
                          checked={toolsEnabled[tool]}
                          onCheckedChange={(checked) =>
                            updateToolsEnabled((prev) => ({ ...prev, [tool]: checked }))
                          }
                        />
                    </div>
                  ))}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>API Keys</CardTitle>
                  <CardDescription>Configure API keys for external service tools.</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  {apiKeyTools.map((tool) => (
                    <div key={tool.id} className="rounded-2xl border border-jet/10 bg-fog/70 p-4">
                      <div className="flex items-center justify-between mb-1">
                        <div>
                          <p className="font-medium text-ink text-sm">{tool.label}</p>
                          <p className="text-xs text-smoked">{tool.description}</p>
                        </div>
                        {tool.configured && !apiKeyInputs[tool.id] && (
                          <Badge variant="outline" className="text-green-700 border-green-300 bg-green-50">
                            {tool.maskedKey}
                          </Badge>
                        )}
                      </div>
                      <div className="flex gap-2 mt-2">
                        <Input
                          type="password"
                          placeholder={tool.configured ? "Enter new key to update" : "Paste API key"}
                          value={apiKeyInputs[tool.id] || ""}
                          onChange={(e) => setApiKeyInputs((prev) => ({ ...prev, [tool.id]: e.target.value }))}
                          className="flex-1"
                        />
                        <Button
                          variant="accent"
                          size="sm"
                          disabled={!apiKeyInputs[tool.id] || apiKeySaving === tool.id}
                          onClick={async () => {
                            setApiKeySaving(tool.id);
                            try {
                              const res = await fetch("/api/config/set", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ path: tool.configPath, value: apiKeyInputs[tool.id] }),
                              });
                              if (!res.ok) throw new Error("Save failed");
                              setApiKeyInputs((prev) => ({ ...prev, [tool.id]: "" }));
                              await loadApiKeys();
                            } catch { /* ignore */ }
                            setApiKeySaving(null);
                          }}
                        >
                          {apiKeySaving === tool.id ? "..." : "Save"}
                        </Button>
                      </div>
                      {tool.signupUrl && (
                        <a href={tool.signupUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 hover:underline mt-1 inline-block">
                          Get an API key
                        </a>
                      )}
                    </div>
                  ))}
                  {apiKeyTools.length === 0 && (
                    <p className="text-sm text-smoked">Loading...</p>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Config</CardTitle>
                  <CardDescription>Update defaults without touching the config file.</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                  {configError && (
                    <div className="rounded-2xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
                      {configError}
                    </div>
                  )}
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-smoked">LLM Provider</label>
                    <select
                      value={form.provider}
                      onChange={(e) => setForm((prev) => ({ ...prev, provider: e.target.value }))}
                      className="flex h-10 w-full rounded-xl border border-jet/20 bg-white px-3 py-2 text-sm text-ink shadow-sm focus:border-jet/40 focus:outline-none"
                    >
                      <option value="auto">Auto-detect</option>
                      <option value="openrouter">OpenRouter</option>
                      <option value="anthropic">Anthropic</option>
                      <option value="openai">OpenAI</option>
                      <option value="azure_openai">Azure OpenAI</option>
                      <option value="deepseek">DeepSeek</option>
                      <option value="gemini">Gemini</option>
                      <option value="groq">Groq</option>
                      <option value="dashscope">Dashscope (Qwen)</option>
                      <option value="moonshot">Moonshot</option>
                      <option value="zhipu">Zhipu GLM</option>
                      <option value="minimax">MiniMax</option>
                      <option value="volcengine">VolcEngine</option>
                      <option value="byteplus">BytePlus</option>
                      <option value="siliconflow">SiliconFlow</option>
                      <option value="aihubmix">AiHubMix</option>
                      <option value="ollama">Ollama (local)</option>
                      <option value="vllm">vLLM (local)</option>
                      <option value="custom">Custom (OpenAI-compatible)</option>
                    </select>
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-smoked">API Key</label>
                    <Input
                      type="password"
                      value={form.providerApiKey}
                      onChange={(e) => setForm((prev) => ({ ...prev, providerApiKey: e.target.value }))}
                      placeholder={form._maskedKey ? `Current: ${form._maskedKey}` : "Paste provider API key"}
                    />
                    <p className="text-xs text-smoked">
                      Leave blank to keep the current key. Saved to the selected provider.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-smoked">Model ID</label>
                    <Input
                      value={form.model}
                      onChange={(e) => setForm((prev) => ({ ...prev, model: e.target.value }))}
                      placeholder="e.g. anthropic/claude-sonnet-4-6"
                    />
                    <p className="text-xs text-smoked">
                      Full model identifier. Use provider prefix for routed models (e.g. openai/gpt-5-mini).
                    </p>
                  </div>

                  <Separator />

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <label className="text-xs font-medium text-smoked">Temperature</label>
                      <Input
                        value={form.temperature}
                        onChange={(e) => setForm((prev) => ({ ...prev, temperature: e.target.value }))}
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs font-medium text-smoked">Max tokens</label>
                      <Input
                        value={form.maxTokens}
                        onChange={(e) => setForm((prev) => ({ ...prev, maxTokens: e.target.value }))}
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-smoked">Context window</label>
                    <Input
                      value={form.contextWindowTokens}
                      onChange={(e) => setForm((prev) => ({ ...prev, contextWindowTokens: e.target.value }))}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-smoked">Timezone</label>
                    <Input
                      value={form.timezone}
                      onChange={(e) => setForm((prev) => ({ ...prev, timezone: e.target.value }))}
                      placeholder="e.g. America/New_York (empty = system default)"
                    />
                    <p className="text-xs text-smoked">
                      IANA timezone used for prompts, tasks, and scheduling.
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="accent" onClick={handleSaveConfig}>Save config</Button>
                    <Button variant="outline" onClick={loadConfig}>Reload</Button>
                  </div>

                  <Separator />

                  <div className="space-y-2">
                    <label className="text-xs font-medium text-smoked">JSON patch</label>
                    <Textarea value={patchText} onChange={(e) => setPatchText(e.target.value)} />
                  </div>
                  <Button variant="outline" onClick={handlePatch}>Apply patch</Button>

                  <Separator />

                  <div className="space-y-2">
                    <label className="text-xs font-medium text-smoked">Setup Wizard</label>
                    <p className="text-xs text-smoked">Re-run the onboarding wizard to update your profile and provider settings.</p>
                    <Button variant="outline" onClick={() => setShowOnboarding(true)}>Run Setup Wizard</Button>
                  </div>
                </CardContent>
              </Card>
                </div>
              </div>
            )}

            {activeSection === "Integrations" && (
              <div className="h-full overflow-y-auto pr-2">
                <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
                  {/* Composio API Key */}
                  <Card className="lg:col-span-2">
                    <CardHeader>
                      <CardTitle>Composio API Key</CardTitle>
                      <CardDescription>
                        Integrations are powered by <a href="https://composio.dev" target="_blank" rel="noopener noreferrer" className="underline">Composio</a>.
                        Get your API key from the Composio dashboard.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-3">
                      {integrationsError && (
                        <div className="rounded-2xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
                          {integrationsError}
                        </div>
                      )}
                      <div className="flex items-center gap-3">
                        <Input
                          type="password"
                          placeholder={integrations.hasApiKey ? integrations.maskedApiKey || "Key saved" : "Enter Composio API key"}
                          value={composioKeyInput}
                          onChange={(e) => setComposioKeyInput(e.target.value)}
                          className="flex-1"
                        />
                        <Button
                          variant="accent"
                          size="sm"
                          disabled={composioKeySaving || !composioKeyInput.trim()}
                          onClick={handleSaveComposioKey}
                        >
                          {composioKeySaving ? "Saving..." : "Save"}
                        </Button>
                      </div>
                      {integrations.hasApiKey && (
                        <p className="text-xs text-green-600">API key is configured.</p>
                      )}
                    </CardContent>
                  </Card>

                  {/* Integrations grid */}
                  <Card className="lg:col-span-2">
                    <CardHeader>
                      <CardTitle>Integrations</CardTitle>
                      <CardDescription>Connect external services to enable integrations.</CardDescription>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-4">
                      {!integrations.hasApiKey && (
                        <div className="rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-700">
                          Add your Composio API key above to connect integrations.
                        </div>
                      )}
                      <div className="grid gap-3 lg:grid-cols-2">
                        {(integrations.toolkits || []).map((toolkit) => {
                          const connected = integrations.connected?.includes(toolkit.id);
                          return (
                            <div key={toolkit.id} className="flex items-center justify-between rounded-2xl border border-jet/10 bg-fog/70 px-4 py-4">
                              <div>
                                <p className="font-medium text-ink">{toolkit.label || toolkit.id}</p>
                                <p className="text-xs text-smoked">{toolkit.slug || toolkit.id}</p>
                              </div>
                              <Button
                                variant={connected ? "outline" : "accent"}
                                size="sm"
                                disabled={!integrations.hasApiKey || connected || connecting === toolkit.id}
                                onClick={() => handleConnectIntegration(toolkit.id)}
                              >
                                {connected ? "Connected" : connecting === toolkit.id ? "Connecting..." : "Connect"}
                              </Button>
                            </div>
                          );
                        })}
                      </div>
                    </CardContent>
                  </Card>
                </div>
              </div>
            )}

            {activeSection === "Tasks" && (
              <div className="h-full overflow-y-auto pr-2">
                <div className="grid gap-6">
                  <Card>
                    <CardHeader className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <CardTitle>Automation & Jobs</CardTitle>
                        <CardDescription>Manage scheduled jobs created by the agent or integrations.</CardDescription>
                      </div>
                      <div className="flex items-center gap-2">
                        {tasksStatus?.jobs !== undefined && (
                          <Badge>{tasksStatus.jobs} jobs</Badge>
                        )}
                        {!taskCreating && (
                          <Button variant="accent" size="sm" onClick={() => setTaskCreating(true)}>
                            Create
                          </Button>
                        )}
                        <Button variant="outline" size="sm" onClick={loadTasks} disabled={tasksLoading}>
                          {tasksLoading ? "Refreshing..." : "Refresh"}
                        </Button>
                      </div>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-4">
                      {tasksError && (
                        <div className="rounded-2xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
                          {tasksError}
                        </div>
                      )}

                      {/* Create automation form */}
                      {taskCreating && (
                        <div className="rounded-2xl border border-jet/10 bg-fog/30 p-4 space-y-3">
                          <p className="text-sm font-medium text-ink">New Automation</p>
                          <div className="space-y-2">
                            <label className="text-xs font-medium uppercase tracking-[0.3em] text-smoked">Name</label>
                            <Input
                              value={taskForm.name}
                              onChange={(e) => setTaskForm((f) => ({ ...f, name: e.target.value }))}
                              placeholder="e.g. Daily summary"
                            />
                          </div>
                          <div className="space-y-2">
                            <label className="text-xs font-medium uppercase tracking-[0.3em] text-smoked">Schedule type</label>
                            <select
                              className="w-full rounded-2xl border border-jet/10 bg-fog/70 px-3 py-2 text-sm text-ink focus:outline-none"
                              value={taskForm.schedule_kind}
                              onChange={(e) => setTaskForm((f) => ({ ...f, schedule_kind: e.target.value }))}
                            >
                              <option value="every">Recurring interval</option>
                              <option value="cron">Cron expression</option>
                              <option value="at">One-shot (run once)</option>
                            </select>
                          </div>

                          {taskForm.schedule_kind === "every" && (
                            <div className="space-y-2">
                              <label className="text-xs font-medium uppercase tracking-[0.3em] text-smoked">
                                Every (minutes)
                              </label>
                              <Input
                                type="number"
                                min="1"
                                value={taskForm.every_minutes}
                                onChange={(e) => setTaskForm((f) => ({ ...f, every_minutes: e.target.value }))}
                                placeholder="30"
                              />
                            </div>
                          )}

                          {taskForm.schedule_kind === "cron" && (
                            <>
                              <div className="space-y-2">
                                <label className="text-xs font-medium uppercase tracking-[0.3em] text-smoked">
                                  Cron expression
                                </label>
                                <Input
                                  value={taskForm.cron_expr}
                                  onChange={(e) => setTaskForm((f) => ({ ...f, cron_expr: e.target.value }))}
                                  placeholder="0 9 * * *"
                                />
                                <p className="text-xs text-smoked">
                                  Format: minute hour day-of-month month day-of-week
                                </p>
                              </div>
                              <div className="space-y-2">
                                <label className="text-xs font-medium uppercase tracking-[0.3em] text-smoked">
                                  Timezone (optional)
                                </label>
                                <Input
                                  value={taskForm.cron_tz}
                                  onChange={(e) => setTaskForm((f) => ({ ...f, cron_tz: e.target.value }))}
                                  placeholder={form.timezone ? `Default: ${form.timezone}` : "e.g. America/New_York"}
                                />
                                {form.timezone && !taskForm.cron_tz && (
                                  <p className="text-xs text-smoked">
                                    Will use global timezone: {form.timezone}
                                  </p>
                                )}
                              </div>
                            </>
                          )}

                          {taskForm.schedule_kind === "at" && (
                            <div className="space-y-2">
                              <label className="text-xs font-medium uppercase tracking-[0.3em] text-smoked">
                                Date & Time
                              </label>
                              <Input
                                type="datetime-local"
                                value={taskForm.at_datetime}
                                onChange={(e) => setTaskForm((f) => ({ ...f, at_datetime: e.target.value }))}
                              />
                            </div>
                          )}

                          <div className="space-y-2">
                            <label className="text-xs font-medium uppercase tracking-[0.3em] text-smoked">
                              Message / Prompt
                            </label>
                            <Textarea
                              value={taskForm.message}
                              onChange={(e) => setTaskForm((f) => ({ ...f, message: e.target.value }))}
                              placeholder="What should the agent do when this job runs?"
                              rows={3}
                              className="min-h-[80px]"
                            />
                          </div>

                          <Separator />

                          <div className="flex items-center justify-between">
                            <div>
                              <p className="text-sm font-medium text-ink">Deliver response</p>
                              <p className="text-xs text-smoked">Send the result to a channel</p>
                            </div>
                            <Switch
                              checked={taskForm.deliver}
                              onCheckedChange={(checked) => setTaskForm((f) => ({ ...f, deliver: checked }))}
                            />
                          </div>

                          {taskForm.deliver && (
                            <div className="grid gap-3 sm:grid-cols-2">
                              <div className="space-y-2">
                                <label className="text-xs font-medium uppercase tracking-[0.3em] text-smoked">Channel</label>
                                <Input
                                  value={taskForm.channel}
                                  onChange={(e) => setTaskForm((f) => ({ ...f, channel: e.target.value }))}
                                  placeholder="e.g. telegram"
                                />
                              </div>
                              <div className="space-y-2">
                                <label className="text-xs font-medium uppercase tracking-[0.3em] text-smoked">To (recipient)</label>
                                <Input
                                  value={taskForm.to}
                                  onChange={(e) => setTaskForm((f) => ({ ...f, to: e.target.value }))}
                                  placeholder="e.g. chat ID or phone"
                                />
                              </div>
                            </div>
                          )}

                          {taskForm.schedule_kind === "at" && (
                            <div className="flex items-center justify-between">
                              <div>
                                <p className="text-sm font-medium text-ink">Delete after run</p>
                                <p className="text-xs text-smoked">Remove job once executed</p>
                              </div>
                              <Switch
                                checked={taskForm.delete_after_run}
                                onCheckedChange={(checked) => setTaskForm((f) => ({ ...f, delete_after_run: checked }))}
                              />
                            </div>
                          )}

                          <div className="flex gap-2 justify-end pt-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setTaskCreating(false)}
                            >
                              Cancel
                            </Button>
                            <Button
                              size="sm"
                              variant="accent"
                              onClick={handleCreateTask}
                              disabled={!taskForm.name.trim() || !taskForm.message.trim()}
                            >
                              Create
                            </Button>
                          </div>
                        </div>
                      )}

                      {tasksLoading && tasks.length === 0 && (
                        <div className="rounded-2xl border border-dashed border-jet/20 p-6 text-sm text-smoked">
                          Loading tasks...
                        </div>
                      )}
                      {!tasksLoading && tasks.length === 0 && (
                        <div className="rounded-2xl border border-dashed border-jet/20 p-6 text-sm text-smoked">
                          No jobs yet. Create one by asking the assistant to schedule a task.
                        </div>
                      )}
                      <div className="grid gap-3">
                        {tasks.map((job) => {
                          const action = taskActions[job.id];
                          const lastStatus = job.state?.lastStatus;
                          const statusLabel = lastStatus || "idle";
                          const statusClass =
                            lastStatus === "ok"
                              ? "bg-emerald-100 text-emerald-700"
                              : lastStatus === "error"
                                ? "bg-red-100 text-red-700"
                                : "bg-blunt/80 text-smoked";
                          return (
                            <div key={job.id} className="rounded-2xl border border-jet/10 bg-fog/70 p-4">
                              <div className="flex flex-wrap items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <p className="font-medium text-ink">{job.name}</p>
                                  <p className="text-xs text-smoked">{job.payload?.message || "No payload"}</p>
                                </div>
                                <div className="flex items-center gap-3">
                                  <Badge className={statusClass}>{statusLabel}</Badge>
                                  <Switch
                                    checked={job.enabled}
                                    onCheckedChange={(checked) => handleTaskToggle(job.id, checked)}
                                    disabled={action === "toggle" || action === "remove"}
                                  />
                                </div>
                              </div>
                              <div className="mt-3 grid gap-2 text-xs text-smoked sm:grid-cols-2 lg:grid-cols-4">
                                <div>
                                  <p className="text-[11px] uppercase tracking-[0.2em]">Schedule</p>
                                  <p className="text-sm text-ink">{formatSchedule(job)}</p>
                                </div>
                                <div>
                                  <p className="text-[11px] uppercase tracking-[0.2em]">Next run</p>
                                  <p className="text-sm text-ink">
                                    {job.enabled ? formatDateTime(job.state?.nextRunAtMs) : "Disabled"}
                                  </p>
                                </div>
                                <div>
                                  <p className="text-[11px] uppercase tracking-[0.2em]">Last run</p>
                                  <p className="text-sm text-ink">{formatDateTime(job.state?.lastRunAtMs)}</p>
                                </div>
                                <div>
                                  <p className="text-[11px] uppercase tracking-[0.2em]">Job ID</p>
                                  <p className="text-sm text-ink">{job.id}</p>
                                </div>
                              </div>
                              {job.state?.lastError && (
                                <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                                  {job.state.lastError}
                                </div>
                              )}
                              <div className="mt-4 flex flex-wrap gap-2">
                                <Button
                                  size="sm"
                                  onClick={() => handleTaskRun(job)}
                                  disabled={action === "run" || action === "remove"}
                                >
                                  {action === "run" ? "Running..." : "Run now"}
                                </Button>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => handleTaskRemove(job.id)}
                                  disabled={action === "remove"}
                                >
                                  {action === "remove" ? "Removing..." : "Remove"}
                                </Button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </CardContent>
                  </Card>
                </div>
              </div>
            )}

            {activeSection === "Channels" && (
              <div className="h-full overflow-y-auto pr-2">
                <div className="grid gap-6">
                  {channelDefinitions.map((channel) => {
                    const channelForm = channelForms[channel.id] || {};
                    const saving = Boolean(channelSaving[channel.id]);
                    return (
                      <Card key={channel.id}>
                        <CardHeader>
                          <CardTitle>{channel.label}</CardTitle>
                          <CardDescription>{channel.description}</CardDescription>
                        </CardHeader>
                        <CardContent className="flex flex-col gap-4">
                          {channelErrors[channel.id] && (
                            <div className="rounded-2xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
                              {channelErrors[channel.id]}
                            </div>
                          )}
                          <div className="flex flex-col gap-3">
                            {channel.fields.map((field) => {
                              const value = channelForm[field.name];
                              if (field.type === "switch") {
                                return (
                                  <div key={field.name} className="flex items-center justify-between">
                                    <p className="text-sm font-medium text-ink">{field.label}</p>
                                    <Switch
                                      checked={Boolean(value)}
                                      onCheckedChange={(checked) =>
                                        handleChannelFieldChange(channel.id, field.name, checked)
                                      }
                                      disabled={saving}
                                    />
                                  </div>
                                );
                              }
                              if (field.type === "textarea") {
                                return (
                                  <div key={field.name} className="space-y-2">
                                    <label className="text-xs font-medium uppercase tracking-[0.3em] text-smoked">
                                      {field.label}
                                    </label>
                                    <Textarea
                                      value={value ?? ""}
                                      onChange={(e) =>
                                        handleChannelFieldChange(channel.id, field.name, e.target.value)
                                      }
                                      rows={3}
                                      className="min-h-[96px]"
                                      disabled={saving}
                                    />
                                    {field.helper && (
                                      <p className="text-xs text-smoked">{field.helper}</p>
                                    )}
                                  </div>
                                );
                              }
                              if (field.type === "select") {
                                return (
                                  <div key={field.name} className="space-y-2">
                                    <label className="text-xs font-medium uppercase tracking-[0.3em] text-smoked">
                                      {field.label}
                                    </label>
                                    <select
                                      className="w-full rounded-2xl border border-jet/10 bg-fog/70 px-3 py-2 text-sm text-ink focus:outline-none"
                                      value={value ?? ""}
                                      onChange={(e) =>
                                        handleChannelFieldChange(channel.id, field.name, e.target.value)
                                      }
                                      disabled={saving}
                                    >
                                      {field.options.map((option) => (
                                        <option key={option.value} value={option.value}>
                                          {option.label}
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                );
                              }
                              return (
                                <div key={field.name} className="space-y-2">
                                  <label className="text-xs font-medium uppercase tracking-[0.3em] text-smoked">
                                    {field.label}
                                  </label>
                                  <Input
                                    value={value ?? ""}
                                    onChange={(e) =>
                                      handleChannelFieldChange(channel.id, field.name, e.target.value)
                                    }
                                    placeholder={field.placeholder}
                                    disabled={saving}
                                  />
                                </div>
                              );
                            })}
                          </div>
                          <div className="flex justify-end">
                            <Button
                              size="sm"
                              variant="accent"
                              onClick={() => handleSaveChannel(channel.id)}
                              disabled={saving}
                            >
                              {saving ? "Saving..." : "Save"}
                            </Button>
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ─── Knowledge Section ─── */}
            {activeSection === "Knowledge" && (
              <div className="h-full overflow-y-auto pr-2 space-y-4">
                {knowledgeError && (
                  <p className="text-sm text-red-500 bg-red-50 rounded-2xl px-4 py-2">{knowledgeError}</p>
                )}

                {/* System Prompts */}
                {["SOUL", "USER"].map((name) => (
                  <Card key={name}>
                    <CardHeader>
                      <div className="flex items-center justify-between">
                        <div>
                          <CardTitle className="text-base">
                            {name === "SOUL" ? "Soul (Personality)" : "User Profile"}
                          </CardTitle>
                          <CardDescription>
                            {name === "SOUL"
                              ? "Defines the assistant's personality, values, and communication style."
                              : "Information about you to help personalize interactions."}
                          </CardDescription>
                        </div>
                        {knowledgeEditing !== name && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setKnowledgeEditing(name);
                              setKnowledgeEditText(knowledgePrompts[name]);
                            }}
                          >
                            Edit
                          </Button>
                        )}
                      </div>
                    </CardHeader>
                    <CardContent>
                      {knowledgeEditing === name ? (
                        <div className="space-y-3">
                          <Textarea
                            value={knowledgeEditText}
                            onChange={(e) => setKnowledgeEditText(e.target.value)}
                            rows={14}
                            className="min-h-[280px] font-mono text-xs"
                            disabled={knowledgeSaving}
                          />
                          <div className="flex gap-2 justify-end">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setKnowledgeEditing(null)}
                              disabled={knowledgeSaving}
                            >
                              Cancel
                            </Button>
                            <Button
                              size="sm"
                              variant="accent"
                              onClick={() => handleSavePrompt(name)}
                              disabled={knowledgeSaving}
                            >
                              {knowledgeSaving ? "Saving..." : "Save"}
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <pre className="whitespace-pre-wrap text-xs text-smoked bg-fog/50 rounded-xl p-4 max-h-[200px] overflow-y-auto">
                          {knowledgePrompts[name] || "(empty)"}
                        </pre>
                      )}
                    </CardContent>
                  </Card>
                ))}

                {/* Knowledge Files */}
                <Card>
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <div>
                        <CardTitle className="text-base">Knowledge Files</CardTitle>
                        <CardDescription>
                          Upload files as knowledge base (max 20 files, 10 MB each).
                        </CardDescription>
                      </div>
                      <Button
                        size="sm"
                        variant="accent"
                        onClick={() => knowledgeFileRef.current?.click()}
                        disabled={knowledgeUploading}
                      >
                        {knowledgeUploading ? "Uploading..." : "Upload"}
                      </Button>
                      <input
                        type="file"
                        ref={knowledgeFileRef}
                        onChange={handleUploadKnowledge}
                        className="hidden"
                      />
                    </div>
                  </CardHeader>
                  <CardContent>
                    {knowledgeFiles.length === 0 ? (
                      <p className="text-sm text-smoked">No knowledge files uploaded yet.</p>
                    ) : (
                      <div className="space-y-2">
                        {knowledgeFiles.map((f) => (
                          <div
                            key={f.name}
                            className="flex items-center justify-between rounded-xl border border-jet/10 px-4 py-2"
                          >
                            <div className="min-w-0 flex-1">
                              <p className="text-sm font-medium text-ink truncate">{f.name}</p>
                              <p className="text-xs text-smoked">
                                {(f.size / 1024).toFixed(1)} KB
                              </p>
                            </div>
                            <Button
                              size="sm"
                              variant="outline"
                              className="text-red-500 hover:text-red-600 ml-3"
                              onClick={() => handleDeleteKnowledgeFile(f.name)}
                            >
                              Delete
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>
            )}

            {/* ─── Memory Section ─── */}
            {activeSection === "Memory" && (
              <div className="h-full overflow-y-auto pr-2 space-y-4">
                {memoryError && (
                  <p className="text-sm text-red-500 bg-red-50 rounded-2xl px-4 py-2">{memoryError}</p>
                )}
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Memories</CardTitle>
                    <CardDescription>
                      Past interaction memories stored by the assistant. Click to read, or delete entries you no longer need.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {memories.length === 0 ? (
                      <p className="text-sm text-smoked">No memories stored yet. Memories are created automatically during conversations.</p>
                    ) : (
                      <div className="space-y-2">
                        {memories.map((m) => (
                          <div key={m.filename}>
                            <div
                              className="flex items-center justify-between rounded-xl border border-jet/10 px-4 py-3 cursor-pointer hover:bg-fog/50 transition-colors"
                              onClick={() => handleReadMemory(m.filename)}
                            >
                              <div className="min-w-0 flex-1">
                                <p className="text-sm font-medium text-ink">{m.filename}</p>
                                <p className="text-xs text-smoked truncate">{m.preview.split("\n")[0]}</p>
                              </div>
                              <div className="flex items-center gap-2 ml-3">
                                <span className="text-xs text-smoked">
                                  {(m.size / 1024).toFixed(1)} KB
                                </span>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="text-red-500 hover:text-red-600"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleDeleteMemory(m.filename);
                                  }}
                                >
                                  Delete
                                </Button>
                              </div>
                            </div>
                            {memoryReading === m.filename && (
                              <pre className="whitespace-pre-wrap text-xs text-smoked bg-fog/50 rounded-xl p-4 mt-2 max-h-[400px] overflow-y-auto border border-jet/5">
                                {memoryContent}
                              </pre>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>
            )}

            {/* ─── Skills Section ─── */}
            {activeSection === "Skills" && (
              <div className="h-full overflow-y-auto pr-2 space-y-4">
                {skillError && (
                  <p className="text-sm text-red-500 bg-red-50 rounded-2xl px-4 py-2">{skillError}</p>
                )}
                <Card>
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <div>
                        <CardTitle className="text-base">Skills</CardTitle>
                        <CardDescription>
                          Skills teach the assistant how to use specific tools or perform tasks.
                        </CardDescription>
                      </div>
                      {!skillCreating && (
                        <Button
                          size="sm"
                          variant="accent"
                          onClick={() => setSkillCreating(true)}
                        >
                          Add Skill
                        </Button>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent>
                    {/* Create new skill form */}
                    {skillCreating && (
                      <div className="space-y-3 mb-4 p-4 rounded-xl border border-jet/10 bg-fog/30">
                        <Input
                          value={newSkillName}
                          onChange={(e) => setNewSkillName(e.target.value)}
                          placeholder="Skill name (e.g. my-tool)"
                        />
                        <Textarea
                          value={newSkillContent}
                          onChange={(e) => setNewSkillContent(e.target.value)}
                          placeholder={"---\nname: my-tool\ndescription: What this skill does\n---\n\n# My Tool\n\nInstructions for the assistant..."}
                          rows={10}
                          className="min-h-[200px] font-mono text-xs"
                        />
                        <div className="flex gap-2 justify-end">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setSkillCreating(false);
                              setNewSkillName("");
                              setNewSkillContent("");
                            }}
                          >
                            Cancel
                          </Button>
                          <Button
                            size="sm"
                            variant="accent"
                            onClick={handleCreateSkill}
                            disabled={!newSkillName.trim() || !newSkillContent.trim()}
                          >
                            Create
                          </Button>
                        </div>
                      </div>
                    )}

                    {skills.length === 0 ? (
                      <p className="text-sm text-smoked">No skills found.</p>
                    ) : (
                      <div className="space-y-2">
                        {skills.map((s) => (
                          <div key={s.name}>
                            <div
                              className="flex items-center justify-between rounded-xl border border-jet/10 px-4 py-3 cursor-pointer hover:bg-fog/50 transition-colors"
                              onClick={() => handleReadSkill(s.name)}
                            >
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                  <p className="text-sm font-medium text-ink">{s.name}</p>
                                  <Badge variant={s.source === "builtin" ? "secondary" : "outline"}>
                                    {s.source}
                                  </Badge>
                                  {!s.available && (
                                    <Badge variant="destructive">unavailable</Badge>
                                  )}
                                </div>
                                <p className="text-xs text-smoked">{s.description}</p>
                              </div>
                              {s.source === "workspace" && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="text-red-500 hover:text-red-600 ml-3"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleDeleteSkill(s.name);
                                  }}
                                >
                                  Delete
                                </Button>
                              )}
                            </div>
                            {skillReading === s.name && (
                              <pre className="whitespace-pre-wrap text-xs text-smoked bg-fog/50 rounded-xl p-4 mt-2 max-h-[400px] overflow-y-auto border border-jet/5">
                                {skillContent}
                              </pre>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>
            )}
          </div>
        </main>
      </div>
      {showOnboarding && (
        <OnboardingWizard
          initialConfig={config}
          onComplete={() => {
            setShowOnboarding(false);
            loadConfig();
          }}
        />
      )}
    </div>
  );
}
