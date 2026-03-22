import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "./ui/accordion";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const roleStyles = {
  user: "bg-ink text-fog",
  assistant: "bg-fog text-ink border border-jet/10",
  tool: "bg-blunt/70 text-ink",
  system: "bg-blunt/50 text-ink",
  error: "bg-smoked text-fog"
};

export default function ChatMessage({ role, content, timestamp, meta }) {
  const flow = meta?.flow || [];
  const showMeta = flow.length > 0;
  const normalized = (content || "").replace(/\n{3,}/g, "\n\n");
  return (
    <div className={cn("flex flex-col gap-2", role === "user" ? "items-end" : "items-start")}>
      {showMeta && role === "assistant" && (
        <div className="w-full max-w-[85%] rounded-3xl border border-jet/10 bg-blunt/60 p-3 text-xs text-smoked">
          <Accordion type="multiple" className="space-y-2">
            {flow.map((item, idx) => (
              <AccordionItem key={`${item.type}-${idx}`} value={`${item.type}-${idx}`}>
                <AccordionTrigger>
                  {item.type === "tool" ? "Tool Call" : "Thinking"}
                </AccordionTrigger>
                <AccordionContent>
                  <div className="rounded-2xl bg-fog/80 px-3 py-2 text-ink">
                    {item.content}
                  </div>
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      )}
      <div
        className={cn(
          "max-w-[85%] rounded-3xl px-5 py-4 text-sm leading-5",
          roleStyles[role] || roleStyles.assistant
        )}
      >
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            p: ({ node, ...props }) => (
              <p {...props} className="my-1 leading-5" />
            ),
            ul: ({ node, ...props }) => (
              <ul {...props} className="my-1 list-disc pl-5 space-y-0.5" />
            ),
            ol: ({ node, ...props }) => (
              <ol {...props} className="my-1 list-decimal pl-5 space-y-0.5" />
            ),
            li: ({ node, ...props }) => (
              <li {...props} className="my-0" />
            ),
            a: ({ node, ...props }) => (
              <a {...props} className="underline underline-offset-2" target="_blank" rel="noreferrer" />
            ),
            code: ({ inline, className, children, ...props }) => (
              <code
                className={cn(
                  "rounded bg-ink/10 px-1.5 py-0.5 font-mono text-xs",
                  !inline && "block whitespace-pre-wrap p-3"
                )}
                {...props}
              >
                {children}
              </code>
            )
          }}
        >
          {normalized}
        </ReactMarkdown>
      </div>
      <div className="flex items-center gap-2 text-xs text-smoked">
        <Badge className="bg-fog/80">{role}</Badge>
        {meta?.tool && <span className="text-xs">{meta.tool}</span>}
        {timestamp && <span>{timestamp}</span>}
      </div>
    </div>
  );
}
