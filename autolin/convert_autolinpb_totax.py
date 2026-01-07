import cmd
import subprocess
import argparse
import os 
import sys
import gzip

'''
next iteration of this will likely be a snakemake workflow
'''
'''
This currently assumes that the user can run matUtils and usher_to_taxonium 
'''

'''
sequence of commands:
run autolin to get autolin.pb (make user do this currently)
run matUtils extract -i autolin.pb -C autolin_clade.pb -o autolin_clade.tsv (make user do this currently)
either rename first column to strain and optionally rename other columns 
or join autolin_clade.tsv with metadata file to get metadata file with autolin annotations
run usher_to_taxonium with --clade_types to convert autolin.pb to taxonium json

#make an effort to separate script for sc2 and everything else at some point 
'''
def parse_args():
    parser = argparse.ArgumentParser(description="Convert an AutoLIN protobuf file to a Taxonium JSON file.")
    parser.add_argument("--autolin_pb_path", "-a", type=str, required=True, help="Path to the input AutoLIN protobuf file.")
    #prob dont need this anymore, unless original Sc2 tree is used
    parser.add_argument("--sars-cov-2", "-sc2", action="store_true", help="Flag indicating if the data is SARS-CoV-2. Special \
        options must be handled for SC2")
    parser.add_argument("--additional_meta_data", "-amd", type=str, required=False, help="Path to tab separated metadata file, if additional metadata is desired. Sample ID column MUST be first.")
    #save this for later. make sure alex is changing the name of the column in taxonium
    #parser.add_argument("--rename_annotation_column", "-o", type=str, required=False, help="Path to the output Taxonium JSON file. If not provided, \
    #    the output will be saved in the same directory as the input AutoLIN protobuf file with a .jsonl.gz extension.")
    return parser.parse_args()

def get_annotations(autolin_pb_path, parent_dir):
    """
    Convert an AutoLIN protobuf file to a Taxonium JSON file.

    Parameters:
    autolin_pb_path (str): Path to the input AutoLIN protobuf file.
    taxonium_json_path (str): Path to the output Taxonium JSON file.
    """
    
    command = ["matUtils", "summary",
               "-i", autolin_pb_path,
               "-C", "./autolin_clade.tsv",
               ]
    #print(command)
    try:
        subprocess.run(command, check=True)
    except Exception as e:
        print(f"matUtils command ({' '.join(command)}) failed: {e}", file=sys.stderr)
        sys.exit(1)

def fix_metadata(clade_file):
    #rename first column to strain
    command = "sed -i '1s/^[^ \t]*/strain/' "+clade_file
    subprocess.run(command, shell=True, check=True)

def usher_to_taxonium(autolin_pb_path, clade_file, sc2, columns):
    #this is a crude version that doesnt have any option for column name changing 
    #next iteration will need to read column names so im not hardcoding them 
    #will deal with this in next iteration
    print('clade file', clade_file)
    if sc2:
        #command= ["usher_to_taxonium","-i", autolin_pb_path, "--clade_types", "nextclade,pango", "-m", clade_file, "-c", "strain,annotation_1,annotation_2", "-o", autolin_pb_path.replace(".pb", ".jsonl.gz")]
        print("Currently, SARS-CoV-2 is unsupported. Check back in later releases. Exiting.", file=sys.stderr)
        sys.exit(1)

    command= ["usher_to_taxonium","-i", autolin_pb_path, "--clade_types", "pango", "-m", "phenometa.tsv", "-c", ",".join(columns), "-o", autolin_pb_path.replace(".pb", ".jsonl.gz")]
    #print(command)
    subprocess.run(command, check=True)

def is_gzipped(filepath):
    with open(filepath, 'rb') as f:
        return f.read(2) == b'\x1f\x8b'

#one avenue to handle this. 
#i think i prefer a join command 
#need to figure out what docker supports for gzip
'''
def read_metadata(file, clade_file):
    header = file.readline().strip()
    print(header)
    assert '\t' in header, f"Error: metadata is not tab-separated."
    print('metadata is tab separated')
    header.append
    


def merge_meta(amd, clade_file):
    print('HERE')
    if is_gzipped(amd):
        with gzip.open(amd, 'rt') as f:
            read_metadata(f, clade_file)
    else:
        with open(amd, 'r') as f:
            read_metadata(f, clade_file)
'''

#THIS CODE BLOCK IS NOT FINAL
#MIXING PYTHON AND BASH IS NOT PREFERRED
#WILL UPDATE SOON
#note these commands use bash specific syntax
#this may not work in all environments
#i think this is ok for now since taxonium and usher_to_taxonium are also bash
#need to check with docker container
#all of this will likely be refactored into a snakemake workflow later
def merge_meta(amd, clade_file):
    with open(clade_file, 'r') as f:
        header = f.readline().strip().split('\t')
    #this ensures that all files have one annotation per node.
    #maybe change later if there is a need 
    assert len(header) == 2, f"Error: {clade_file} does not have exactly 2 columns."
    if is_gzipped(amd):
        cmd1 = f"echo \"$(head -n1 {clade_file})\\t$(zcat {amd} | head -n1 | cut -f2-)\" > phenometa.tsv"
        cmd2 = f"join -t $'\\t' <(tail -n +2 {clade_file} | sort -k1,1) <(zcat {amd} | tail -n +2 | sort -k1,1) >> phenometa.tsv"
    else:
        cmd1 = f"echo \"$(head -n1 {clade_file})\\t$(head -n1 {amd} | cut -f2-)\" > phenometa.tsv"
        cmd2 = f"join -t $'\\t' <(tail -n +2 {clade_file} | sort -k1,1) <(tail -n +2 {amd} | sort -k1,1) >> phenometa.tsv"
    subprocess.run(cmd1, shell=True, check=True)
    subprocess.run(cmd2, shell=True, check=True, executable="/bin/bash")
    with open('phenometa.tsv', 'r') as f:
        columns = f.readline().strip().split('\t')
    return columns

#this currently assumes that there is only 1 annotation within the mat
#it will break if there are more than 1
def main(): 
    args = parse_args()
    autolin_pb_path = args.autolin_pb_path
    amd = None
    if args.additional_meta_data:
        amd = args.additional_meta_data
    #make sure directory handling is consistent between scripts
    parent_dir = os.path.dirname(os.path.abspath(autolin_pb_path))
    sc2 = args.sars_cov_2
    #print(parent_dir)
    print(autolin_pb_path)
    get_annotations(autolin_pb_path, parent_dir)
    #make sure autolin_clade.tsv is not empty
    clade_file = None

    with open("./autolin_clade.tsv", 'r') as f:
        if sum(1 for _ in f) == 1:
            print(f"Error: autolin_clade.tsv was not created or is empty.", file=sys.stderr)
            sys.exit(1)        
        else:
            clade_file = "./autolin_clade.tsv"
            print('clade', clade_file)
            fix_metadata(clade_file)
            if amd != None:
                columns = merge_meta(amd, clade_file)
            else:
                subprocess.run(f"mv {clade_file} phenometa.tsv", shell=True, check=True)
                with open('phenometa.tsv', 'r') as f:
                    header = f.readline().strip().split('\t')
                    assert len(header) == 2, f"Error: {clade_file} does not have exactly 2 columns."
                    columns = header
                    #columns = f.readline().strip().split('\t')
    usher_to_taxonium(autolin_pb_path, clade_file, sc2, columns)

if __name__ == "__main__":
    main()