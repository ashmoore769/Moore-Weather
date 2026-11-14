# Dark mode and Home Screen help

Moore Weather uses a permanent dark appearance across Dashboard, Daily Summary, Forecast, Help, sign-in and the station terminal. Moore Music and Moore Family keep their own appearance settings.

## Appearance

- The theme switch is removed. A saved light preference or a device using a light appearance cannot change Moore Weather to light mode.
- Every page starts with `data-theme="dark"` and a dark `color-scheme` declaration. The synchronous theme bootstrap preserves the dark palette, native form controls and `#0d1722` browser theme colour before content appears.
- The bootstrap replaces old `mooreWeatherTheme` preferences with `dark` and marks preference version `5`. Browser storage is optional; denied storage does not prevent the page from loading or applying dark mode.
- Pages load `/theme.js?v=6` so browsers fetch the current behaviour. Existing light CSS is inactive and retained to keep this change small.
- The PWA manifest, icons and installation flow are unchanged. This change needs no environment variables, database updates or station configuration.

## Home Screen help

Help is available from dashboard controls, page footers and the sign-in page. It detects iPhone/iPad, Android or computer and offers manual instructions, a copy-address button, and a native install button when the browser supports one. Help works before signing in; weather pages and data remain password protected.

Installation still requires the visitor to choose the install action and approve the browser prompt. Dismissing or failing that prompt leaves the manual instructions available. Already-installed apps hide redundant installation prompts. Copying the address excludes private paths and query strings.

## Validation

Run `node --test test/theme-install.test.js` for the focused regression suite. It covers saved light preferences, system appearance, changes from older open tabs, denied browser storage, initial dark paint, browser theme colour, matching page copies, absent theme controls and the Home Screen installation flow.

Browser checks should use a device set to light appearance and a stored version-4 light preference, then verify that the rendered page and native controls remain dark. Also check navigation, reloads, narrow-screen header spacing and Home Screen launch. These are checks of the permanent-dark policy; test fixtures must not manually force the document back to light mode.
