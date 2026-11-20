// One icon set for the whole app: Lucide (lucide-react, ISC license). Icons draw with
// currentColor, so they follow the text color in Light and Dark mode.
import React from "react";
import type { LucideIcon, LucideProps } from "lucide-react";

/** A Lucide icon sized for buttons and inline text (16 px, stroke 2), hidden from screen readers. */
export const Icon: React.FC<{ icon: LucideIcon } & LucideProps> = ({ icon: Glyph, size = 16, strokeWidth = 2, className, ...rest }) => (
  <Glyph size={size} strokeWidth={strokeWidth} aria-hidden="true" focusable="false" className={className ? `fp-icon ${className}` : "fp-icon"} {...rest} />
);
