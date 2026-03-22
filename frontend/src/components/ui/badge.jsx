import * as React from "react";
import { cn } from "../../lib/utils";

const Badge = ({ className, ...props }) => (
  <span
    className={cn(
      "inline-flex items-center rounded-full border border-jet/10 bg-blunt/70 px-3 py-1 text-xs font-medium text-ink",
      className
    )}
    {...props}
  />
);

export { Badge };
