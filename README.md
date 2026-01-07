# Lineage Curation

Automated phylogenetic lineage proposal and interactive curation.

**Input**: UShER MAT protobuf file (`.pb`)  
**Output**: Proposed sub-lineages + interactive curation UI

## Build the Docker Container

```bash
# Build once
docker build -t lineage-curation .

```

Open http://localhost:3000

## Run Autolin and Lineage Curation UI

```bash
# Interactive mode
docker run -it -v "$PWD":/workspace -p 3000:3000 -p 8001:8001 lineage-curation

# Inside container - generate proposals
cd /workspace/autolin
python propose_sublineages.py -i /workspace/your_tree.pb -o /workspace/your_tree.autolin.pb

# Creates jsonl.gz file in same directory (<your_tree.autolin>.jsonl.gz)

python convert_autolinpb_totax.py -a /workspace/your_tree.autolin.pb

# Launch UI with generated file
cd /workspace/ui/linolium
./run-prod.sh /workspace/your_tree.autolin.jsonl.gz
```

## Components

- **[autolin/](autolin/)** - Autolin algorithm for lineage proposals
- **[ui/](ui/)** - Web interface for curation
- **[recombination-detection/](recombination-detection/)** - Recombination analysis
