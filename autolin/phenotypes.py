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


"""
import os 
import argparse
import subprocess
import gzip

'''
This script will take in a metadata file, and several options for how to weight phenotypes, and output a file with sample IDs and weights that can be used in autolin.
'''

def parse_args():
    parser = argparse.ArgumentParser(description="Process phenotype data.")
    parser.add_argument("--metadata_file", '-m', type=str, required=True, help="Path to the input metadata file. Note: this script currently expects a tab-delimited file with a header line. Other formats may not work correctly.",)
    #not sure if i need this
    parser.add_argument("--mat", "-t", type=str, required=True, help="Path to the input mutation annotated tree",)
    #im going to going eventually make this take col name or number 
    #im considering making col name and col number lists to allow for multiple phenotypes to be processed at once, but for now just one
    '''
    parser.add_argument(
        "--column-name",
        "-c",
        type=str,
        required=True,
        help="Name of the column to extract from the metadata file. NOTE: Must exactly match the header name in the metadata file.",
    )
    '''
    parser.add_argument("--column-number", "-n", type=int, help="Column number (0-indexed) of the column to extract from the metadata file. NOTE: 0 is assumed to be the sample name",)
    #this is not required but will likely be needed often
    
    #need to add option for this
    parser.add_argument("--categories", "-C", nargs='+', help='A list of strings of categories in order of increasing severity. NOTE: if strings do not exactly match metadata, an error will occur', required=False, help="Path to the input mutation annotated tree")
    
    #i want to add a flag that gives the option to not use equally distanced weighting 
    #parser.add_argument("--weighting-scheme", "-w", choices=['frequency', 'ordinal'], required=True, help="Weighting scheme to use for the phenotypes. 'frequency' will assign higher weights to rarer phenotypes, while 'ordinal' will assign weights based on the order of categories provided with the --categories option.")
    parser.add_argument("--numerical", action="store_true", help="Treat the column as numerical data.")
    parser.add_argument("--frequency-based", action="store_true", help="Flag to indicate that frequency-based weighting should be used.")
    parser.add_argument("--tb_profiler_abr", action="store_true", help="Flag to indicate that the metadata file is from TBProfiler and should be processed accordingly. This will override the --column-number option and use the 'TBProfiler_abr' column for phenotypes.")
    parser.add_argument("--output_file", '-o', type=str, required=True, help="Path to the output file.",)
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
def tb_profiler(metadata, output):
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

def process_args(args):
    #things to add:
    #if column number is provided make sure column number is valid and extract column name from header
    #print column name for confirmation
    #make sure there is enough arg value to find a weighting approach 
    print(args)
    process = ""
    if args.tb_profiler_abr:
        process = "TBProfiler_abr"
    #if args.frequency_based:
    #    process = "frequency_based"
    #if args.categories:
    #if 
    #else:
    #    column_name = args.column_number
    return process

def main():
    args = parse_args()
    process = process_args(args)
    print("Process:", process)
    tree = args.mat
    samples = get_samples(tree)
    print(f"Extracted {len(samples)} samples from the tree.")
    meta = get_metadata(samples, args.metadata_file, args.column_name)
    print(len(meta))

    #try frequency based 
    #frequency_based_weight(meta, args.output_file)
    #ordinal based
    if process == "TBProfiler_abr":
        tb_profiler(meta, args.output_file)
    
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
"""