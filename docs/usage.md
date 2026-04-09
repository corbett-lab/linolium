# Usage Guide

## Running AutoLin

### 1. Upload a tree

From the launcher screen, upload a UShER MAT protobuf file (`.pb` or `.pb.gz`). Files stay local — the pipeline runs entirely inside your Docker container.

### 2. Configure parameters

Before running the pipeline, adjust the AutoLin parameters:

| Parameter | Description | Default |
|-----------|-------------|---------|
| **Min Samples** | Minimum number of samples required to form a lineage | 10 |
| **Distinction** | Minimum branch length (mutations) separating a proposed lineage from its parent | 1 |
| **Recursive** | Whether to recursively subdivide proposed lineages | On |
| **Verbose** | Print detailed progress during the run | Off |

Additional parameters are available under **Advanced Options**:

- **Uniformity** — threshold for how uniformly a clade must be annotated (0-1)
- **Foldover** — controls how aggressively to split ambiguous clades

### 3. Run the pipeline

Click **Run Pipeline**. The pipeline has three stages:

1. **Proposing lineages** — runs `propose_sublineages.py` on the uploaded tree
2. **Converting** — converts the annotated tree to Taxonium display format
3. **Loading viewer** — loads the result into the interactive tree viewer

Progress and logs are displayed in real time. When complete, download links appear for the annotated tree in `.jsonl.gz`, `.pb.gz`, and `.tsv` formats.

---

## Curating Lineages

Once the viewer loads, the **Lineage Explorer** sidebar (left panel) shows all proposed lineages in a hierarchical tree.

### Lineage list

Each lineage entry shows:

- The **lineage name** (e.g., `auto.lineage4.8.13`)
- **Sub-lineage count** — number of child lineages
- **Sample count** — number of tips assigned to this lineage

Click a lineage to highlight it in the tree. Hover to preview.

AutoLin proposes new lineages prefixed with `auto.`, each colored distinctly (sub-lineages use lighter tints of the parent's color). Samples keeping their original (non-`auto.`) labels stay a neutral gray.

### Editing lineages

Select a lineage to reveal its action buttons:

- **Zoom** — centers the tree view on this lineage's clade
- **Edit root** — reassign the lineage to a different node. After clicking, your cursor becomes a crosshair. Click any node in the tree to set it as the new root for this lineage. Press Escape or click Cancel to abort
- **Merge** — dissolve this lineage into its parent. All samples are reassigned to the parent lineage

After any edit, the tree view and sidebar update automatically to reflect the new state.

### Edit log and undo

Every edit is recorded in the **Edit Log** panel (above the lineage list). Edits are shown in chronological order:

- **M** (blue) = merge operation
- **E** (yellow) = edit-root operation

Each entry has an **undo button** (↩). Hovering over it highlights which edits would be reverted — if later edits conflict (touch the same lineages), they are highlighted in red with strikethrough. Non-conflicting edits are preserved.

### Navigating the tree

- **Pan** — click and drag
- **Zoom** — scroll wheel
- **Node details** — click any node to see its metadata
- **Search** — use the search panel (right sidebar) to find nodes by name or mutation

### Downloading results

After curation, use the download links at the top of the sidebar to export the current state of the tree. Available formats:

- `.jsonl.gz` — Taxonium display format
- `.pb.gz` — annotated protobuf (can be re-uploaded for further curation)
- `.tsv` — sample-to-lineage mapping table
