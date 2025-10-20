#!/usr/bin/env python3
import zipfile
import os
from pathlib import Path

def create_lambda_package():
    zip_path = 'function.zip'

    # Remove old zip if exists
    if os.path.exists(zip_path):
        os.remove(zip_path)

    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
        # Add main files
        for file in ['index.js', 'package.json']:
            if os.path.exists(file):
                zipf.write(file, file)
                print(f'Added: {file}')

        # Add node_modules selectively (only production dependencies)
        if os.path.exists('node_modules'):
            for root, dirs, files in os.walk('node_modules'):
                # Skip aws-sdk (provided by Lambda runtime)
                if 'aws-sdk' in root:
                    continue
                # Skip development dependencies and large files
                if any(skip in root for skip in ['.bin', 'test', 'tests', 'example', 'examples', 'docs', '.cache']):
                    continue

                for file in files:
                    # Skip unnecessary files
                    if file.endswith(('.md', '.txt', '.map', '.ts', '.yml', '.yaml')):
                        continue
                    if file.startswith('.'):
                        continue

                    file_path = os.path.join(root, file)
                    arcname = file_path
                    zipf.write(file_path, arcname)

    print(f'\nDeployment package created: {zip_path}')
    print(f'Size: {os.path.getsize(zip_path) / (1024*1024):.2f} MB')

if __name__ == '__main__':
    create_lambda_package()
