# Dark mode and Home Screen help

This update makes access-request confirmation friendlier, defaults every page to dark mode, left-aligns the soil profile heading and readings, and adds Home Screen installation help.

## Behaviour

- Accepted requests say: "Thanks for requesting access! I'll get back to you shortly by email." Pending email notifications still have a separate, accurate message. Formspree configuration and delivery logic are unchanged.
- Existing version 3 theme preferences reset to dark once because that version saved light automatically. After this update, an explicit light or dark choice is remembered across pages.
- The soil probe image and five reading rows remain in place. Their text and values align to the left.
- Help is available from the dashboard controls, page footers and sign-in page. It detects iPhone/iPad, Android or computer and offers manual instructions, a copy-address button, and a native install button when the browser supports one. Help works before signing in; weather pages and data remain password protected.
- Narrow dashboard titles can wrap to leave room for the new Help button without reducing touch targets.

## Upload

1. Extract **Moore-Weather-Dark-Mode-and-Home-Screen.zip** into a new folder.
2. Open https://github.com/ashmoore769/Moore-Weather/upload/main.
3. Drag the extracted **lib**, **public**, **test**, **docs** folders and **server.js** together into the upload area. Do not upload the ZIP or flatten the folders.
4. Check that GitHub lists **18 files**, including `public/help.html`, `lib/access-requests.js`, and `docs/DARK-MODE-AND-HOME-SCREEN.md`, then commit the upload to main.
5. Wait for the Render deployment to finish before checking the site.

No environment variables, database settings, station connection settings or email-service setup need changing.

## Validation

The complete offline suite passed: **102 tests**. Syntax checks passed for **56 JavaScript files**, along with local asset references, manifest and dependency checks. Tests cover theme migration and persistence, install-prompt behaviour and failures, public help routes, protected weather routes, and the access-request delivery flow. No live emails were sent and the station collector was not started.

Automated browser previews could not complete because Chrome's preview process crashed in this Windows environment. Visual layout and installation on physical phones still need checking after deployment.

After deployment, refresh the page and check dark mode on sign-in, Current, Daily Summary and Help. Confirm the soil alignment and header on a narrow screen. Open Help on iPhone/Safari and Android/Chrome and follow the displayed steps. A deliberately selected light theme should persist on the next page and after reload.
