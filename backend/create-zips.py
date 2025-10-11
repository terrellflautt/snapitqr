import zipfile
import os

lambdas = [
    'qr-operations',
    'url-operations',
    'auth-operations',
    'stripe-operations',
    'authorizer'
]

for lambda_dir in lambdas:
    if not os.path.exists(lambda_dir):
        print(f"Directory {lambda_dir} not found, skipping...")
        continue

    zip_name = f"snapitqr-{lambda_dir.replace('-', '-')}"
    zip_path = os.path.join(lambda_dir, f"{zip_name}.zip")

    print(f"Creating {zip_path}...")

    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
        for root, dirs, files in os.walk(lambda_dir):
            # Skip the ZIP file itself
            if zip_path in root:
                continue

            # Skip .git and other unnecessary directories
            dirs[:] = [d for d in dirs if d not in ['.git', '__pycache__', 'node_modules/.cache']]

            for file in files:
                if file.endswith('.zip'):
                    continue

                file_path = os.path.join(root, file)
                # Calculate archive name (relative to lambda_dir)
                arcname = os.path.relpath(file_path, lambda_dir)
                zipf.write(file_path, arcname)

    size = os.path.getsize(zip_path) / (1024 * 1024)
    print(f"✓ Created {zip_name}.zip ({size:.2f} MB)")

print("\n✓ All ZIP files created successfully")
