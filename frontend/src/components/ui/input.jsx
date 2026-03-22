import * as React from "react";
import { cn } from "../../lib/utils";

const Input = React.forwardRef(({ className, type = "text", ...props }, ref) => (
  <input
    ref={ref}
    type={type}
    className={cn(
      "flex h-11 w-full rounded-2xl border border-jet/10 bg-fog/80 px-4 text-sm text-ink transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-jet/30",
      className
    )}
    {...props}
  />
));
Input.displayName = "Input";

export { Input };
