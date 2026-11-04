import { useLingui } from "@lingui/react/macro";
import { ToggleGroup, ToggleGroupItem } from "@rakazo/ui-web";
import { useState } from "react";
import { setUiLocale } from "../lib/i18n";

/** Uses the same persisted app language as account settings and desktop menus. */
export function LanguageSwitcher() {
  const { t, i18n } = useLingui();
  const [pending, setPending] = useState(false);
  return (
    <ToggleGroup
      aria-label={t`Language`}
      data-testid="language-switcher"
      value={[i18n.locale]}
      disabled={pending}
      onValueChange={([locale]) => {
        if (locale !== "en" && locale !== "zh-CN") return;
        setPending(true);
        void setUiLocale(locale).finally(() => setPending(false));
      }}
      className="app-no-drag gap-0 rounded-lg border bg-muted/50 p-0.5"
    >
      <ToggleGroupItem
        value="zh-CN"
        lang="zh-CN"
        className="h-7 px-3 text-xs aria-pressed:bg-background aria-pressed:shadow-sm"
      >
        中文
      </ToggleGroupItem>
      <ToggleGroupItem
        value="en"
        lang="en"
        className="h-7 px-3 text-xs aria-pressed:bg-background aria-pressed:shadow-sm"
      >
        English
      </ToggleGroupItem>
    </ToggleGroup>
  );
}
