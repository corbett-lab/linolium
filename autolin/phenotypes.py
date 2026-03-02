import os 
import argparse
import subprocess
import gzip

'''
'''

def parse_args():
    parser = argparse.ArgumentParser(description="Process phenotype data.")
    parser.add_argument(
        "--metadata_file",
        '-m',
        type=str,
        required=True,
        help="Path to the input metadata file. Note: this script currently expects a tab-delimited file with a header line. Other formats may not work correctly.",
    )
    parser.add_argument(
        "--mat",
        "-t",
        type=str,
        required=True,
        help="Path to the input mutation annotated tree",
    )
    parser.add_argument(
        "--column-name",
        "-c",
        type=str,
        required=True,
        help="Name of the column to extract from the metadata file. NOTE: Must exactly match the header name in the metadata file.",
    )
    '''
    parser.add_argument(
        "--run_autolin",
        "-r",
        action='store_true',
        help="If flagged, autolin will run from this script with the -p flag and generated weights ",
    )
    '''
    parser.add_argument(
        "--output_file", 
        '-o',
        type=str,
        required=True,
        help="Path to the output file.",
    )
    return parser.parse_args()

def get_samples(tree):
    cmd = f"matUtils summary -i {tree} -s samples.subprocess"
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"Command failed with error: {result.stderr}")
    with open("samples.subprocess", 'r') as f:
        samples = [line.strip().split()[0] for line in f if line.strip()]
    os.remove("samples.subprocess")
    return samples

#maybe this should be a join command? 
#not sure 
def read_meta(file, samples, column_name):
    metadata = {}
    headers = file.readline().strip().split('\t')
    print(headers)
    if column_name not in headers:
        raise ValueError(f"Column '{column_name}' not found in metadata file headers.")
    col_index = headers.index(column_name)
    for line in file:
        parts = line.strip('\n').split('\t')
        sample_id = parts[0]
        #print(sample_id)
        if sample_id in samples:
            #i think a subdict it less useful
            metadata[sample_id] = parts[col_index]
            #metadata[sample_id] = {headers[col_index]: parts[col_index]}
    #print(metadata)
    return metadata

def get_metadata(samples, metadata_file, column_name):
    if metadata_file.endswith(".gz"):
        with gzip.open(metadata_file, "rt") as gz:
            metadata = read_meta(gz, samples, column_name)
    else:
        with open(metadata_file, 'r') as f:
            metadata = read_meta(f, samples, column_name)
    return metadata

def frequency_based_weight(metadata, output):

    counts = {}
    for p in metadata.values():
        if p in counts:
            counts[p] += 1
        else:
            counts[p] = 1

    total = sum(counts.values())

    # Compute frequency-based weights (rarer = higher weight)
    weights = {}
    for sample, p in metadata.items():
        freq = counts[p] / total
        weights[sample] = 1 - freq
    with open(output, 'w') as f:
        f.write("Sample\tWeight\tPhenotype\n")
        for sample in metadata:
            f.write(f"{sample}\t{weights[sample]:.4f}\t{metadata[sample]}\n")
            #f.write((f"{sample}\t{weights[sample]:.4f}\n"))

#will change this to make it more general later 
def ordinal_based_weight(metadata, output):
    categories = ["Sensitive", "HR-TB", "RR-TB", "MDR-TB", "Pre-XDR-TB", "XDR-TB"]
    n = len(categories)
    weights = {cat: (i+1)/n for i, cat in enumerate(categories)}
    

    # Compute frequency-based weights (rarer = higher weight)
    #for sample, p in metadata.items():
    #    metadata[sample] = weights[p]
    #    weights[sample] = 1 - freq
    weight = 0.0
    with open(output, 'w') as f:
        f.write("Sample\tWeight\tPhenotype\n")
        for sample in metadata:
            if metadata[sample] not in weights:
                weight = 0.5 #default weight if not in categories
            else:
                weight = weights[metadata[sample]]
            f.write(f"{sample}\t{weight:.4f}\t{metadata[sample]}\n")
            #f.write((f"{sample}\t{weights[sample]:.4f}\n"))

def format_outputs(output_file):
    cmd = f"cut -f1,3 {output_file} > pheno.pheno.tsv"
    subprocess.run(cmd, shell=True, capture_output=True, text=True)
    cmd = f"cut -f1,2 {output_file} > pheno.weights.tsv"
    subprocess.run(cmd, shell=True, capture_output=True, text=True)
    #this may cause local issues
    #cmd = f"python3 propose_sublineages.py -i {args.mat} -p pheno.weights.tsv -o {args.mat.replace('.pb', '.pheno.autolin.pb')}"
    #run these within convert ?
    #cmd = f"echo -e \"$(head -n1 autolin_clade.tsv)\t$(head -n1 pheno.pheno.tsv | cut -f2-)\" > phenometa.tsv"
    #subprocess.run(cmd, shell=True, capture_output=True, text=True)
    #cmd = f"join -t $'\t'     <(tail -n +2 autolin_clade.tsv | sort -k1,1)     <(tail -n +2 pheno.pheno.tsv | sort -k1,1) >> phenometa.tsv"
    #subprocess.run(cmd, shell=True, capture_output=True, text=True)

def main():
    args = parse_args()
    tree = args.mat
    samples = get_samples(tree)
    print(f"Extracted {len(samples)} samples from the tree.")
    meta = get_metadata(samples, args.metadata_file, args.column_name)
    print(len(meta))

    #try frequency based 
    #frequency_based_weight(meta, args.output_file)
    #ordinal based
    ordinal_based_weight(meta, args.output_file)
    format_outputs(args.output_file)
    print("Weights and phenotypes written to pheno.weights.tsv and pheno.pheno.tsv respectively.")
    
    '''
    # Read metadata file
    with open(args.metadata_file, 'r') as f:
        metadata_lines = f.readlines()
    
    # Read mutation annotated tree file
    with open(args.mat, 'r') as f:
        mat_lines = f.readlines()
    
    # Process data (this is a placeholder for actual processing logic)
    processed_data = []
    for line in metadata_lines:
        if line.strip():  # Skip empty lines
            processed_data.append(line.strip())
    
    for line in mat_lines:
        if line.strip():  # Skip empty lines
            processed_data.append(line.strip())
    
    # Write to output file
    with open(args.output_file, 'w') as f:
        for item in processed_data:
            f.write(f"{item}\n")
    
    print(f"Processed data written to {args.output_file}")
    '''

if __name__ == "__main__":
    main()