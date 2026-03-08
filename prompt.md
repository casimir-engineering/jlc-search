Build a web app for searching JLCPCB / LCSC parts, inspired by:
- https://yaqwsx.github.io/jlcparts/#/
- https://github.com/yaqwsx/jlcparts

## Goal
Create a simpler, cleaner alternative to the existing `jlcparts` web interface, with a strong focus on **very fast, Google-like search** and a minimal UI.

## Core requirements

### 1. Data source / compatibility
- Reuse the existing part downloading and processing system from `yaqwsx/jlcparts` as much as possible.
- Do **not** reinvent the downloader if it can be reused.
- If the user has already downloaded libraries/databases using `yaqwsx/jlcparts`, the new app should be able to use those existing files directly without re-downloading.
- Design the app so the indexing/search layer can work on top of the existing downloaded dataset.

### 2. First version scope
The first version should prioritize:
- simple setup
- simple UI
- very fast search
- fuzzy search / typo tolerance
- good relevance ranking

Do **not** implement advanced parametric filtering yet, but design the code so it can be added later.

### 3. Search UX
The main experience should feel like a search engine:
- one prominent search bar
- instant results or very fast search response
- typo-tolerant / fuzzy search
- relevance-ranked results

If you think fuzzy search alone is not the best option, propose a better search approach for this use case, such as:
- tokenized indexing
- exact match boosting
- prefix match boosting
- MPN/LCSC exact hit priority
- description keyword ranking
- optional fuzzy fallback

Explain the tradeoffs and choose a practical implementation.

### 4. Filters under the search bar
Include a few simple toggles/filters similar to the JLCPCB parts site:

#### Parts type
- Basic
- Promotional Extended
- Extended
- Mechanical Assembly

#### PCBA type
- Economic
- Standard

#### Other toggles
- In stock only
- Enable fuzzy search

These should be simple checkboxes/toggles/chips under the search bar.

### 5. Result layout
Each search result should display:

- Picture
- Manufacturer Part Number
- LCSC reference number
- Part type
- PCBA type
- Description
- Stock
- Price
- Datasheet link
- "Go to JLC" button
- "Go to SZLCSC" button

Preferred layout:
- Main title line: **MFR part number + LCSC reference**
- Secondary info: **part type + PCBA type**
- Then description
- Then stock and pricing
- Then action links/buttons

### 6. UI requirements
- Keep the interface much simpler than the original `jlcparts` page
- Clean, minimal, responsive design
- Desktop-first is acceptable, but mobile should still be usable
- Fast loading and smooth filtering
- Avoid visual clutter

### 7. Technical expectations
Please propose a suitable architecture before implementing.

Consider:
- frontend framework
- local vs server-side search
- indexing strategy
- storage format for downloaded part data
- whether to pre-build a search index
- how to support incremental updates
- how to maintain compatibility with `yaqwsx/jlcparts` data

### 8. Deliverables
Provide:

1. **Architecture proposal**
   - frontend
   - backend (if needed)
   - search/indexing strategy
   - data flow
   - compatibility plan with `yaqwsx/jlcparts`

2. **Implementation plan**
   - milestone-based
   - MVP first

3. **Project structure**
   - directory layout
   - key modules/components

4. **MVP implementation**
   - working search page
   - local dataset loading or indexed backend
   - filter toggles
   - results list

5. **Future extension plan**
   - parametric search
   - sorting
   - saved searches
   - BOM upload/search support

## Important constraints
- Reuse existing `yaqwsx/jlcparts` assets and downloader whenever possible
- Minimize duplicate downloads
- Prioritize search quality and speed over advanced filtering
- Keep the first version simple and maintainable

## What I want from you first
Before writing code, do the following:
1. Analyze the existing `yaqwsx/jlcparts` project structure
2. Propose the best architecture for this simpler clone
3. Recommend the best search implementation for this dataset
4. Explain whether the search should be client-side, server-side, or hybrid
5. Then generate the MVP code