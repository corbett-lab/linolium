# Lineage Curation

Automated phylogenetic lineage proposal and interactive curation.

**Input**: UShER MAT protobuf file (`.pb`)  
**Output**: Proposed sub-lineages + interactive curation UI

## Build the Docker Container

```bash
# Build once
docker build -t lineage-curation .

```

## Run Autolin
```bash
# Interactive mode with ports exposed
docker run -it -v "$PWD":/workspace -p 3000:3000 -p 8001:8001 lineage-curation

# Inside container - generate lineage proposals for an input UShER tree, create output tree with proposed lineage annotations
cd /workspace/autolin
python propose_sublineages.py -i /workspace/<input_tree>.pb -o /workspace/<tree_with_lineages>.pb

# Convert Autolin output tree to Taxonium format. Creates <tree_with_lineages>.jsonl.gz file in same directory as <tree_with_lineages>.pb
python convert_autolinpb_totax.py -a /workspace/<tree_with_lineages>.pb
```

## Run Lineage Curation UI
```bash
cd /workspace/ui/linolium
./run-prod.sh /workspace/<tree_with_lineages>.jsonl.gz # Starts frontend web UI on port 3000, backend on 8001
```

## View and edit lineages in UI

Open http://localhost:3000 in a web browser 

## Components

- **[autolin/](autolin/)** - Autolin algorithm for lineage proposals
- **[ui/](ui/)** - Web interface for curation
- **[recombination-detection/](recombination-detection/)** - Recombination analysis
