# Agent frontend checklist

- Sign in: submit valid-looking credentials and confirm the preview dashboard opens.
- Wrong password: confirm the future Supabase adapter can show a selected-language error and next step.
- Unverified agent: confirm backend integration blocks the dashboard until `verification_status` is `verified`.
- Accept job: accept a displayed job and confirm the button/state changes without changing server data.
- Pickup scan: open a `seller_to_agent` job, allow camera, and verify BarcodeDetector/jsQR detection reaches the result panel.
- Delivery scan: open an `agent_to_buyer` job and repeat the scan flow.
- Expired QR: confirm the backend error is shown in English and Kiswahili with a fresh-code instruction.
- Wrong QR type: confirm the backend error is shown without changing assignment state.
- Scan twice: confirm the second backend response is handled as already used.
- Offline banner: disable network and confirm the banner appears; scanning and acceptance remain online-only.
- Camera denied: deny permission and confirm the browser error gives a retry action.
- Language switch: switch EN/SW on sign-in, dashboard, scanner labels, and errors.
