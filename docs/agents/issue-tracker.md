# Issue tracker: GitHub

Issues and specs live in GitHub Issues for BunnyGamezsc/NominaConnect. Use the gh CLI from this clone, with an explicit repository argument when working elsewhere.

## Conventions

- Create one GitHub issue per spec or ticket. Use a body file for multiline content.
- Read the complete issue body, labels, and comments before working from a referenced issue.
- List issues using bounded JSON fields and relevant state or label filters.
- Apply the configured triage role labels. Specs and approved implementation tickets use ready-for-agent.
- Publish blockers before dependent tickets. Use native GitHub blocking relationships with the blocker's database ID. If dependencies are unavailable, include an explicit Blocked by section referencing issue numbers.
- Link implementation tickets to their source spec. Preserve parent issues unless the user explicitly requests changes.
- Posting comments, changing assignments, and closing issues require authorization from the current task or invoked skill.

## Pull requests as a triage surface

PRs as a request surface: no.

## Skill operations

Publish to the issue tracker means create a GitHub issue. Fetch the relevant ticket means read its body, labels, and comments. Distinguish issues from pull requests when resolving a bare GitHub number.

For wayfinding, use a map issue labelled wayfinder:map and link child tickets as sub-issues where available. Otherwise reference the map from the child and retain a task list in the map. Use wayfinder:research, wayfinder:prototype, wayfinder:grilling, or wayfinder:task as appropriate. Work unassigned open children with no open blockers; claim and close work only as authorized by the active workflow.
