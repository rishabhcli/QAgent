# Connection Journey Evidence

This is a point-in-time, read-only inspection of the account connection surfaces used by QAgent. It
is evidence for product wording and remediation links, not proof that a credential stored in QAgent
is valid.

Captured at: `2026-07-23T14:09:35Z`

| Provider    | Source URL                                           | Authorization observed                                                                                             | Product implication                                                                                                                                                              |
| ----------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub      | `https://github.com/settings/personal-access-tokens` | Verified by the authenticated user navigation visible on the settings page. No token values were read or recorded. | Link to the fine-grained token settings page. A saved token remains `configured` until QAgent completes an authenticated repository probe.                                       |
| W&B Weave   | `https://wandb.ai/authorize`                         | Unverified. The page offered Log in and Sign up controls.                                                          | Never infer authorization from the login page. Keep a saved key `configured`; require disclosure before a redacted probe and a real synced trace before end-to-end verification. |
| Browserbase | `https://www.browserbase.com/overview`               | Unverified. The destination redirected to the Browserbase sign-in journey.                                         | Never infer authorization from the redirect. Require both API key and project ID, then run an authenticated project probe before reporting `healthy`.                            |

The browser inspection was performed through Aside against the user's existing browser state. Login
pages, redirects, and credential-shaped input are never treated as authorization evidence.
