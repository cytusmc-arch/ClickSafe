# Third-party files shipped with ClickSafe

All files below are unmodified copies from their official distribution, except the model, which is a
mechanical conversion of the official ONNX file (recipe below). No remote code is loaded at runtime.

## TensorFlow.js 4.22.0 (Apache-2.0)

Source: npm registry (`npm pack @tensorflow/<pkg>@4.22.0`), files copied from `package/dist/`.
Licence: Apache License 2.0, https://github.com/tensorflow/tfjs/blob/master/LICENSE
`tf-core` bundles `long` (Apache-2.0) and `seedrandom` (MIT).

| File | Package | Bytes | sha256 |
|---|---|---|---|
| vendor/tfjs/tf-core.es2017.min.js | @tensorflow/tfjs-core@4.22.0 | 255317 | c55367325aa628ed685164d5c4210892e31c6d2d0e8c163a827b15ad330d1eba |
| vendor/tfjs/tf-backend-cpu.es2017.min.js | @tensorflow/tfjs-backend-cpu@4.22.0 | 126194 | 5d703dd6791356c98c3131aa6340ca48d82806228dfad8b439e83bcaedbb508e |
| vendor/tfjs/tf-backend-wasm.es2017.min.js | @tensorflow/tfjs-backend-wasm@4.22.0 | 144402 | bdd8c3c1fb0b37601bc2a122efa20b8d78e2936d104b03a44591be4188c63f65 |
| vendor/tfjs/tfjs-backend-wasm-simd.wasm | @tensorflow/tfjs-backend-wasm@4.22.0 | 424594 | 77ebb28a6d34f371dbbf2086b7f2de8994acd8ea5a3cf1fa24d2c26c840cac7b |

Package tarball sha256: tfjs-core e8f8aa285ad0237b901e7d79995a1450993cf11fb1b3cc02f09de167fdaf9496,
tfjs-backend-wasm 5cd6f5e18657c12fb94f4ec3dcef485c8c1a9ca39f3ef1d261c1cb13c1a231c3,
tfjs-backend-cpu d3c32e2fe0452fe302e88dde434cd8d7b126ce21754c6c972b28e3bcb8ec0878.
The non-SIMD and threaded `.wasm` variants are intentionally not shipped (Chrome >= 116 always has
WASM SIMD; threads need cross-origin isolation). If the SIMD binary cannot start, the CPU backend is used.

## Image safety model (MIT)

Model: OwenElliott/image-safety-classifier-xs (SwiftFormer-XS fine-tune, 3.0 M parameters, classes
NSFL / NSFW / SFW, card accuracy 97.76 %). Licence: MIT (model card). Base architecture SwiftFormer
(Shaker et al., ICCV 2023) via timm, Apache-2.0.

Source: https://huggingface.co/OwenElliott/image-safety-classifier-xs, file `onnx/image-safety-classifier-xs.onnx`,
repo revision 54f4560bd9c5ee92d45dc30418a8f8680e80de6d, 13137569 bytes,
sha256 8c28c49d9075f3ad15ebdc2961f02d5b3f99be944815b848b49c9f0e6f3fb689.

| File | Bytes | sha256 |
|---|---|---|
| models/isc-xs/model.json | 25405 | 6ade013041acecac6eec7746ca44b03fa1a991d8a2aa84a824a016d7536bfed4 |
| models/isc-xs/weights.bin | 3485348 | faa0696eccc7490f8d4dc206b322c0216efeea348db145b259459a21f575065d |

Conversion: `python -I models/isc-xs/.convert.py image-safety-classifier-xs.onnx models/isc-xs`
(needs `onnx` and `numpy`; deterministic, reproduces the hashes above). It lowers the ONNX graph to an
NHWC op list for TF.js (folds batch-norm / normalisation / layer-scale / GELU constants, all exact) and
stores large weights as per-channel int8 / float16. Measured against onnxruntime on the fp32 ONNX:
max probability difference 0.0049 over 42 benign and synthetic test inputs, same top class on all.
