#====================================================================================================
# START - Testing Protocol - DO NOT EDIT OR REMOVE THIS SECTION
#====================================================================================================

# THIS SECTION CONTAINS CRITICAL TESTING INSTRUCTIONS FOR BOTH AGENTS
# BOTH MAIN_AGENT AND TESTING_AGENT MUST PRESERVE THIS ENTIRE BLOCK

# Communication Protocol:
# If the `testing_agent` is available, main agent should delegate all testing tasks to it.
#
# You have access to a file called `test_result.md`. This file contains the complete testing state
# and history, and is the primary means of communication between main and the testing agent.
#
# Main and testing agents must follow this exact format to maintain testing data. 
# The testing data must be entered in yaml format Below is the data structure:
# 
## user_problem_statement: {problem_statement}
## backend:
##   - task: "Task name"
##     implemented: true
##     working: true  # or false or "NA"
##     file: "file_path.py"
##     stuck_count: 0
##     priority: "high"  # or "medium" or "low"
##     needs_retesting: false
##     status_history:
##         -working: true  # or false or "NA"
##         -agent: "main"  # or "testing" or "user"
##         -comment: "Detailed comment about status"
##
## frontend:
##   - task: "Task name"
##     implemented: true
##     working: true  # or false or "NA"
##     file: "file_path.js"
##     stuck_count: 0
##     priority: "high"  # or "medium" or "low"
##     needs_retesting: false
##     status_history:
##         -working: true  # or false or "NA"
##         -agent: "main"  # or "testing" or "user"
##         -comment: "Detailed comment about status"
##
## metadata:
##   created_by: "main_agent"
##   version: "1.0"
##   test_sequence: 0
##   run_ui: false
##
## test_plan:
##   current_focus:
##     - "Task name 1"
##     - "Task name 2"
##   stuck_tasks:
##     - "Task name with persistent issues"
##   test_all: false
##   test_priority: "high_first"  # or "sequential" or "stuck_first"
##
## agent_communication:
##     -agent: "main"  # or "testing" or "user"
##     -message: "Communication message between agents"

# Protocol Guidelines for Main agent
#
# 1. Update Test Result File Before Testing:
#    - Main agent must always update the `test_result.md` file before calling the testing agent
#    - Add implementation details to the status_history
#    - Set `needs_retesting` to true for tasks that need testing
#    - Update the `test_plan` section to guide testing priorities
#    - Add a message to `agent_communication` explaining what you've done
#
# 2. Incorporate User Feedback:
#    - When a user provides feedback that something is or isn't working, add this information to the relevant task's status_history
#    - Update the working status based on user feedback
#    - If a user reports an issue with a task that was marked as working, increment the stuck_count
#    - Whenever user reports issue in the app, if we have testing agent and task_result.md file so find the appropriate task for that and append in status_history of that task to contain the user concern and problem as well 
#
# 3. Track Stuck Tasks:
#    - Monitor which tasks have high stuck_count values or where you are fixing same issue again and again, analyze that when you read task_result.md
#    - For persistent issues, use websearch tool to find solutions
#    - Pay special attention to tasks in the stuck_tasks list
#    - When you fix an issue with a stuck task, don't reset the stuck_count until the testing agent confirms it's working
#
# 4. Provide Context to Testing Agent:
#    - When calling the testing agent, provide clear instructions about:
#      - Which tasks need testing (reference the test_plan)
#      - Any authentication details or configuration needed
#      - Specific test scenarios to focus on
#      - Any known issues or edge cases to verify
#
# 5. Call the testing agent with specific instructions referring to test_result.md
#
# IMPORTANT: Main agent must ALWAYS update test_result.md BEFORE calling the testing agent, as it relies on this file to understand what to test next.

#====================================================================================================
# END - Testing Protocol - DO NOT EDIT OR REMOVE THIS SECTION
#====================================================================================================



#====================================================================================================
# Testing Data - Main Agent and testing sub agent both should log testing data below this section
#====================================================================================================

user_problem_statement: "RepReady — sales-rep daily prompts mobile app. This iteration: finish the Multi-Account social UI (LinkedIn / Facebook / Instagram) so that users can connect multiple accounts per platform and choose which specific account is used when posting from each company profile."

backend:
  - task: "Multi-account social endpoints (list/delete accounts, link to company)"
    implemented: true
    working: true
    file: "/app/backend/server.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: true
    status_history:
      - working: true
        agent: "main"
        comment: "Previous agent added GET /api/social/{platform}/accounts, DELETE /api/social/{platform}/accounts/{conn_id}, POST /api/companies/{company_id}/link-account, and _execute_social_post now reads active company's linked_accounts[platform] to pick the right Composio connected_account_id. social_connect uses allow_multiple=True. Live logs show 200 OK for all three platforms when settings loads."

  - task: "Scheduler picks up correct connected_account per company"
    implemented: true
    working: "NA"
    file: "/app/backend/server.py"
    stuck_count: 0
    priority: "medium"
    needs_retesting: true
    status_history:
      - working: "NA"
        agent: "main"
        comment: "_background_scheduler calls _execute_social_post which now consults active company linked_accounts. Needs validation — scheduling a near-future post with a specific linked LinkedIn account, then verifying the scheduler invokes the same connected_account_id."

frontend:
  - task: "Multi-account UI in Settings (per-platform list + radio selector)"
    implemented: true
    working: true
    file: "/app/frontend/app/(tabs)/settings.tsx"
    stuck_count: 0
    priority: "high"
    needs_retesting: true
    status_history:
      - working: true
        agent: "main"
        comment: "Replaced old Connect/Disconnect cards with per-platform blocks. Empty state and rendering validated."

  - task: "Companies CRUD UI — add/remove/switch/save multiple companies"
    implemented: true
    working: true
    file: "/app/frontend/app/(tabs)/settings.tsx, /app/frontend/app/company/[id].tsx, /app/frontend/src/components/CompanySocialsSection.tsx"
    stuck_count: 0
    priority: "high"
    needs_retesting: true
    status_history:
      - working: true
        agent: "main"
        comment: "Major UX refactor based on user request. Moved per-company management to a dedicated screen at /company/[id]. Settings tab is now a clean list of company cards (each showing name, ACTIVE badge, website summary, chevron). Tapping a card navigates to the company detail page where users edit name, website, offerings, value props, industry, target audience, auto-fill with AI, link specific social accounts, and delete. + Add another company button is always visible; tapping it shows an inline name input, then Create & open immediately navigates to the new company's detail. The CompanySocialsSection component renders multi-account list + radio button to pick which Composio account this company posts from + trash icon to delete + Connect button to add more. Verified end-to-end via screenshots: empty state → create 2 companies (each opens detail page on creation) → back to settings shows both as cards → tap card opens detail → social linking section displays per-platform blocks with empty state."

  - task: "Per-company social linking via dedicated screen"
    implemented: true
    working: true
    file: "/app/frontend/app/company/[id].tsx, /app/frontend/src/components/CompanySocialsSection.tsx"
    stuck_count: 0
    priority: "high"
    needs_retesting: true
    status_history:
      - working: true
        agent: "main"
        comment: "CompanySocialsSection takes companyId + companyName + linkedAccounts as props, fetches social accounts on mount, shows per-platform blocks with: + Connect button (starts Composio OAuth and adds a new account at user level), radio selector to link/unlink each account to this specific company (calls POST /api/companies/{id}/link-account), trash icon to delete account (calls DELETE /api/social/{platform}/accounts/{id}). The radio button label dynamically shows 'Used by {companyName}'. Each company on its detail page can have its own independent linked account per platform."

  - task: "Generator screen routes to correct linked account"
    implemented: true
    working: "NA"
    file: "/app/frontend/app/generate/[type].tsx"
    stuck_count: 0
    priority: "medium"
    needs_retesting: true
    status_history:
      - working: "NA"
        agent: "main"
        comment: "Frontend doesn't need changes — backend _execute_social_post resolves the linked account server-side from the active company. Needs end-to-end confirmation: connect 2 LinkedIn accounts, link account A to company X / account B to company Y, post from each company and confirm separate connected_account_id is used."

metadata:
  created_by: "main_agent"
  version: "1.0"
  test_sequence: 2
  run_ui: true

test_plan:
  current_focus:
    - "Multi-account social endpoints (list/delete accounts, link to company)"
    - "Multi-account UI in Settings (per-platform list + radio selector)"
  stuck_tasks: []
  test_all: false
  test_priority: "high_first"

agent_communication:
  - agent: "main"
    message: "Finished the multi-account UI in /app/frontend/app/(tabs)/settings.tsx. Backend already had the endpoints — they returned 200 OK in live logs."
  - agent: "main"
    message: "Big refactor: moved per-company management to a dedicated route /company/[id]. Settings now shows companies as a clean card list (testID company-card-{id}) that navigates to detail. Added useFocusEffect in settings.tsx to refresh the list every time the tab regains focus — this fixes the staleness bug found by previous testing agent where deleting on detail page left the card visible in Settings. Cleaned up ~200 lines of dead code (unused state, unused handlers, the latent WebBrowser ReferenceError). Verified live: create 2 companies → navigate to detail → back → delete one → Settings list immediately reflects the deletion. Lint clean (3 cosmetic catch warnings remain). All previous functionality intact: multi-account social linking (radio per company), auto-fill with AI, active company selection, in-context delete confirm."