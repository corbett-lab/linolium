import sys
import pandas as pd
import numpy as np
from sklearn.metrics import adjusted_rand_score

def run_analysis(file_path):
    # Load the data
    df = pd.read_table(file_path)
    
    # Identify columns (Update these strings to match your TSV headers exactly)
    col_unweighted = 'labels_unweighted' 
    col_weighted = 'labels_weighted'

    # 1. Calculate ARI
    ari = adjusted_rand_score(df[col_unweighted], df[col_weighted])
    
    # 2. Get the distribution of clade sizes
    # This counts how many samples are in each sublineage name
    sizes_unweighted = df[col_unweighted].value_counts()
    sizes_weighted = df[col_weighted].value_counts()

    print(f"--- Analysis of {len(df)} samples ---")
    print(f"Adjusted Rand Index: {ari:.4f}\n")

    for label, sizes in [("UNWEIGHTED", sizes_unweighted), ("WEIGHTED", sizes_weighted)]:
        print(f"[{label}]")
        print(f"  Number of clades: {len(sizes)}")
        print(f"  Mean clade size:  {np.mean(sizes):.2f}")
        print(f"  Std Deviation:    {np.std(sizes):.2f}")
        print(f"  Variance:         {np.var(sizes):.2f}")
        print("-" * 20)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 stats.py your_data.tsv")
    else:
        run_analysis(sys.argv[1])
