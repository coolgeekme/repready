# RepReady - Product Requirements Document

## Product
RepReady is a daily sales enablement mobile app (Expo + FastAPI + MongoDB). Sales reps sign in, set their role/industry, then generate role-specific outputs in seconds: cold emails, objection responses, call scripts, company intel, re-engagement messages, and LinkedIn posts.

## Stack
- **Frontend**: Expo SDK 54, expo-router, Firebase JS SDK (email/password), react-native-keyboard-controller, expo-clipboard, expo-document-picker, expo-web-browser
- **Backend**: FastAPI, Motor (MongoDB), emergentintegrations (Claude Sonnet 4.5), composio-core
- **Auth**: Firebase Email/Password (project: repready-b2652)
- **AI Model**: Claude Sonnet 4.5 via Emergent Universal LLM key

## Core Features
1. **Authentication** — Email/password sign-up, sign-in, password reset via Firebase
2. **Dashboard** — Personalized greeting, AI-generated daily focus + 3 action steps, 2-column grid of 6 generators
3. **Generators** (all save automatically to history):
   - Cold Email — 3 variations (subject + body + style tag)
   - Objection Response — 3 distinct approaches (reframe, social proof, discovery)
   - Call Script — 2 openers + 3 discovery questions
   - Company Intel — 5 personalization hooks + 3 likely priorities
   - Re-Engagement — 3 follow-up angles with subjects
   - LinkedIn Post — 2 ready-to-post variations with hashtags + Post-to-LinkedIn button (Composio)
4. **Library** — All generations stored. Filter All/Saved. Toggle save, delete.
5. **Settings** — Role chips, Industry chips, target audience, guidelines text + PDF upload (base64), LinkedIn connect via Composio, sign out

## API Surface (all `/api` prefixed, X-User-Id header required)
- `GET/PUT /users/profile`
- `GET /daily-prompt`
- `POST /generate/{cold-email,objection-response,call-script,company-intel,re-engagement,linkedin-post}`
- `GET /history`, `POST /history/{id}/save`, `DELETE /history/{id}`
- `GET /composio/linkedin/status`, `POST /composio/linkedin/connect`, `POST /composio/linkedin/post`

## Composio LinkedIn
- API key configured in backend env
- Connect button initiates OAuth via Composio, opens browser
- Post-to-LinkedIn button on LinkedIn post results fires `LINKEDIN_CREATE_POST` action

## Design
Swiss/high-contrast light theme. White surfaces with 1px borders, no shadows, sharp corners (radius 4-8px). Primary accent `#0044FF`. Bold tracking-tight headings. Dense 2-col bento grid for generators.

## Out of Scope (MVP)
- Social SSO (Google/Apple/LinkedIn login) — only email/password
- Push notifications
- Team workspaces
