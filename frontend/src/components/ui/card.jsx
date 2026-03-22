import * as React from "react";
import { cn } from "../../lib/utils";

const Card = React.forwardRef(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "rounded-3xl border border-jet/10 bg-fog/90 backdrop-blur-sm",
      className
    )}
    {...props}
  />
));
Card.displayName = "Card";

const CardHeader = ({ className, ...props }) => (
  <div className={cn("px-6 pt-6", className)} {...props} />
);

const CardTitle = ({ className, ...props }) => (
  <h3 className={cn("font-display text-lg font-semibold text-ink", className)} {...props} />
);

const CardDescription = ({ className, ...props }) => (
  <p className={cn("text-sm text-smoked", className)} {...props} />
);

const CardContent = ({ className, ...props }) => (
  <div className={cn("px-6 pb-6", className)} {...props} />
);

export { Card, CardHeader, CardTitle, CardDescription, CardContent };
