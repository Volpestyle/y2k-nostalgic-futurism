import React from "react";

type ClassValue = string | false | null | undefined;

const cx = (...classes: ClassValue[]) => classes.filter(Boolean).join(" ");

export function AppShell({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("ui-app", className)} {...props} />;
}

export function Window({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("ui-window", className)} {...props} />;
}

export function WindowHeader({ className, ...props }: React.HTMLAttributes<HTMLElement>) {
  return <header className={cx("ui-titlebar", className)} {...props} />;
}

export function WindowTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h1 className={cx("ui-title", className)} {...props} />;
}

export function WindowSubtitle({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cx("ui-subtitle", className)} {...props} />;
}

export function WindowBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("ui-window-body", className)} {...props} />;
}

export function Grid({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("ui-grid", className)} {...props} />;
}

export function Panel({ className, ...props }: React.HTMLAttributes<HTMLElement>) {
  return <section className={cx("ui-panel", className)} {...props} />;
}

export function PanelHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("ui-panel-header", className)} {...props} />;
}

export function PanelTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cx("ui-panel-title", className)} {...props} />;
}

export function PanelSubtitle({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cx("ui-panel-sub", className)} {...props} />;
}

export function Group({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("ui-group", className)} {...props} />;
}

export function GroupTitle({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("ui-group-title", className)} {...props} />;
}

export function FieldRow({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("ui-field-row", className)} {...props} />;
}

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cx("ui-label", className)} {...props} />;
}

export const Input = React.forwardRef<HTMLInputElement, React.ComponentPropsWithoutRef<"input">>(
  ({ className, ...props }, ref) => {
    return <input ref={ref} className={cx("ui-field", className)} {...props} />;
  }
);

Input.displayName = "Input";

export const Select = React.forwardRef<HTMLSelectElement, React.ComponentPropsWithoutRef<"select">>(
  ({ className, ...props }, ref) => {
    return <select ref={ref} className={cx("ui-field", className)} {...props} />;
  }
);

Select.displayName = "Select";

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentPropsWithoutRef<"textarea">
>(({ className, ...props }, ref) => {
  return <textarea ref={ref} className={cx("ui-field", className)} {...props} />;
});

Textarea.displayName = "Textarea";

export const Checkbox = React.forwardRef<
  HTMLInputElement,
  Omit<React.ComponentPropsWithoutRef<"input">, "type">
>(({ className, ...props }, ref) => {
  return <input ref={ref} type="checkbox" className={cx("ui-checkbox", className)} {...props} />;
});

Checkbox.displayName = "Checkbox";

export const Range = React.forwardRef<
  HTMLInputElement,
  Omit<React.ComponentPropsWithoutRef<"input">, "type">
>(({ className, ...props }, ref) => {
  return <input ref={ref} type="range" className={cx("ui-range", className)} {...props} />;
});

Range.displayName = "Range";

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost";
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "primary", ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={cx("ui-button", variant === "ghost" && "ui-button-ghost", className)}
        {...props}
      />
    );
  }
);

Button.displayName = "Button";

export function Badge({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return <span className={cx("ui-badge", className)} {...props} />;
}

export function Hint({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cx("ui-hint", className)} {...props} />;
}

export function Status({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("ui-status", className)} {...props} />;
}

export function Divider({ className, ...props }: React.HTMLAttributes<HTMLHRElement>) {
  return <hr className={cx("ui-divider", className)} {...props} />;
}
