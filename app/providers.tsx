"use client";

import { useState } from "react";
import { useServerInsertedHTML } from "next/navigation";
import { ServerStyleSheet, StyleSheetManager } from "styled-components";
import { BladeProvider } from "@razorpay/blade/components";
import { bladeTheme } from "@razorpay/blade/tokens";

/**
 * Blade is built on styled-components and React context, so it can only run
 * inside a client boundary. The style sheet is collected during SSR and
 * flushed into <head>, otherwise the first paint ships unstyled.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [sheet] = useState(() => new ServerStyleSheet());

  useServerInsertedHTML(() => {
    const styles = sheet.getStyleElement();
    sheet.instance.clearTag();
    return <>{styles}</>;
  });

  if (typeof window !== "undefined") {
    return (
      <BladeProvider themeTokens={bladeTheme} colorScheme="dark">
        {children}
      </BladeProvider>
    );
  }

  return (
    <StyleSheetManager sheet={sheet.instance}>
      <BladeProvider themeTokens={bladeTheme} colorScheme="dark">
        {children}
      </BladeProvider>
    </StyleSheetManager>
  );
}
