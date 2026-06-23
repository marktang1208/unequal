# NLI Model Assets

Downloaded from Hugging Face: https://huggingface.co/Xenova/nli-MiniLM-L6-v2/resolve/main

## Files

- `nli-MiniLM-L6-v2-quantized.onnx` (~90MB) — quantized ONNX model
- `tokenizer.json` (~3MB) — WordPiece tokenizer

## How to download

```bash
pnpm -F api download-nli-model
```

The script is idempotent: if files exist and SHA-256 matches the expected hash, it's a no-op. If the hash is unset, it downloads and prints the hash to add back to the script.

## How to update

Delete the existing files and re-run the download script.

## License

Apache 2.0 (inherited from nli-MiniLM-L6-v2 source).
