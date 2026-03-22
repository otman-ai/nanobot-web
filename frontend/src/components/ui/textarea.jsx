import * as React from "react";
import { cn } from "../../lib/utils";

const Textarea = React.forwardRef(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      "min-h-[120px] w-full rounded-2xl border border-jet/10 bg-fog/80 px-4 py-3 text-sm text-ink transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-jet/30",
      className
    )}
    {...props}
  />
));
Textarea.displayName = "Textarea";

export { Textarea };
