# Orbmerge / tittle project context

Updated: 2026-10-07

## Project
Standalone p5.js experience in this repository, separate from capstone-poc.
- `mobile/`: phone shape picker followed by a population canvas with SIGNAL.
- `display/`: separate multi-population display experience.
- `index.html`: entry page linking the two versions.
- GitHub: https://github.com/coha-kim/tittle
- Phone URL: https://coha-kim.github.io/tittle/mobile/index.html
- Deployment: GitHub Pages from master; pushed changes need deployment before phone testing.

## Mobile interaction and appearance
Shake to choose a shape, then Save to enter the canvas. Enable Motion requests sensor permission. SIGNAL uses a held gesture with pointer capture; sustained shaking weakens attraction over about 5 seconds, with recovery over 450 seconds. The latest upstream changes map idle shaking to wander speed independently of attraction; preserve that newer behaviour unless requested otherwise. Population is 10, default blob radius is 24. Spacing correction keeps individuals apart.

Current colour request: blob base colour and background both #2A9284. The existing lighter-centre gradient remains. Applied to both mobile screens and the page background; colour-picker default and accent fallbacks match.

## Working preferences
Avoid repeating prior explanations. Clarify material ambiguity before making changes. Keep this context file current so it can be shared in future sessions. Prior workflow includes committing and pushing approved app changes for phone testing.

## Validation limits
Syntax and source checks do not prove real iPhone sensor behaviour or appearance. Physical-phone verification remains necessary. Keep display changes separate unless requested.
