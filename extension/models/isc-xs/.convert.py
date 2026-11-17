"""Convert OwenElliott/image-safety-classifier-xs (ONNX, MIT) into ClickSafe's compact NHWC program.

Not shipped (dot-file; tools/build.py skips it). Re-run to regenerate model.json + weights.bin:
    python -I .convert.py <path/to/image-safety-classifier-xs.onnx> <out_dir> [--q mixed|int8|f16|f32]

The ONNX graph (opset 18, NCHW) is lowered to a short list of tfjs-friendly ops in NHWC layout:
conv (+bias, +relu, layer-scale folded in), gelu, affine (BN / normalisation / scalar folds),
matmul (+bias), l2norm, sum, mean, add, mul, reshape, softmax. Default "mixed" storage: conv/matmul
weights >= 20000 values as symmetric per-output-channel int8, 4096..20000 as float16, the rest float32;
everything is dequantised to float32 at load time. Measured against onnxruntime on the fp32 ONNX:
max |dp| 0.0048 over 42 benign/synthetic inputs (all-int8: 0.0164, all-f16: 0.0001).
"""
import json
import sys
from pathlib import Path

import numpy as np
import onnx
from onnx import numpy_helper

QMIN = 4096
QMIX = int(__import__("os").environ.get("QMIX", "20000"))


def main(src, out_dir, qmode="int8"):
    m = onnx.load(src)
    g = m.graph
    consts = {t.name: numpy_helper.to_array(t) for t in g.initializer}
    for n in g.node:
        if n.op_type == "Constant":
            consts[n.output[0]] = numpy_helper.to_array(n.attribute[0].t)
    nodes = [n for n in g.node if n.op_type != "Constant"]
    consumers = {}
    for n in nodes:
        for i in n.input:
            consumers.setdefault(i, []).append(n)
    attrs = lambda n: {a.name: onnx.helper.get_attribute_value(a) for a in n.attribute}

    shapes = {}  # name -> int list, -1 = batch
    acts = {}    # name -> dict(id, perm, lshape)
    ops, tensors = [], {}
    done = set()
    nid = [0]

    def new_id():
        nid[0] += 1
        return nid[0]

    def tkey(arr, hint):
        k = f"t{len(tensors)}_{hint}"
        tensors[k] = np.ascontiguousarray(arr, dtype=np.float32)
        return k

    def only_consumer(name):
        c = consumers.get(name, [])
        return c[0] if len(c) == 1 and name not in outputs else None

    def emit(op, out_name, perm, lshape, **kw):
        oid = new_id()
        op = {"op": op, "out": oid, **kw}
        ops.append(op)
        acts[out_name] = {"id": oid, "perm": tuple(perm), "lshape": list(lshape), "op": op}
        return op

    def stored_const(c, a):
        """Broadcast const c (numpy, logical layout) against act a, return in stored layout."""
        c = np.asarray(c, dtype=np.float32)
        r = len(a["perm"])
        if c.ndim == 0:
            return c
        assert c.ndim <= r
        c = c.reshape((1,) * (r - c.ndim) + c.shape).transpose(a["perm"])
        while c.ndim > 1 and c.shape[0] == 1:
            c = c[0]
        return c

    def materialize(name):
        a = acts[name]
        p = a["perm"]
        if p == tuple(range(len(p))):
            return a
        inv = tuple(int(i) for i in np.argsort(p))
        emit("transpose", name, range(len(p)), a["lshape"], x=a["id"], perm=list(inv))
        return acts[name]

    outputs = {o.name for o in g.output}
    inp = g.input[0].name
    acts[inp] = {"id": 0, "perm": (0, 2, 3, 1), "lshape": [-1, 3, 224, 224], "op": None}

    def fold_elementwise(n, a_name, c, kind):
        """x <kind> const: fold into producing conv / matmul / affine when it is the only consumer."""
        a = acts[a_name]
        cs = stored_const(c, a)
        prod = a["op"]
        single = only_consumer(a_name) is n
        if prod is not None and single and prod["op"] in ("conv", "matmul") and prod.get("act", "linear") == "linear":
            cout = tensors[prod["w"]].shape[-1] if prod["op"] == "matmul" or not prod["dw"] else tensors[prod["w"]].shape[2]
            if cs.ndim == 0 or (cs.ndim == 1 and cs.shape[0] == cout):
                w = tensors[prod["w"]]
                b = tensors[prod["b"]] if prod.get("b") else np.zeros(cout, np.float32)
                if kind in ("mul", "div"):
                    f = cs if kind == "mul" else 1.0 / cs
                    if prod["op"] == "conv" and prod["dw"]:
                        w = w * np.asarray(f).reshape((1, 1, -1, 1)) if np.ndim(f) else w * f
                    else:
                        w = w * f
                    b = b * f
                else:
                    b = b + (cs if kind == "add" else -cs)
                tensors[prod["w"]] = w.astype(np.float32)
                prod["b"] = tkey(np.broadcast_to(b, (cout,)), "b")
                acts[n.output[0]] = dict(a)
                return
        if prod is not None and single and prod["op"] == "affine":
            s = tensors[prod["s"]] if prod.get("s") else np.float32(1)
            b = tensors[prod["b"]] if prod.get("b") else np.float32(0)
        else:
            s, b, prod = np.float32(1), np.float32(0), None
        if kind == "mul":
            s, b = s * cs, b * cs
        elif kind == "div":
            s, b = s / cs, b / cs
        elif kind == "add":
            b = b + cs
        elif kind == "sub":
            b = b - cs
        if prod is not None:
            prod["s"] = tkey(s, "s") if np.any(s != 1) else None
            prod["b"] = tkey(b, "b") if np.any(b != 0) else None
            acts[n.output[0]] = dict(a)
        else:
            emit("affine", n.output[0], a["perm"], a["lshape"], x=a["id"],
                 s=tkey(s, "s") if np.any(s != 1) else None, b=tkey(b, "b") if np.any(b != 0) else None)

    def scalar(name):
        c = consts.get(name)
        return float(c.reshape(-1)[0]) if c is not None and c.size == 1 else float("nan")

    def match_gelu(n):
        # Div(x, sqrt2) -> Erf -> Add(1) -> Mul(0.5) -> Mul(x, .)
        if n.op_type != "Div" or not abs(scalar(n.input[1]) - 2 ** 0.5) < 1e-6:
            return None
        e = only_consumer(n.output[0])
        a1 = e and e.op_type == "Erf" and only_consumer(e.output[0])
        if not (a1 and a1.op_type == "Add" and abs(scalar(a1.input[1]) - 1) < 1e-9):
            return None
        m1 = only_consumer(a1.output[0])
        if not (m1 and m1.op_type == "Mul" and abs(scalar(m1.input[0]) - 0.5) < 1e-9):
            return None
        m2 = only_consumer(m1.output[0])
        if not (m2 and m2.op_type == "Mul" and n.input[0] in m2.input):
            return None
        return [e, a1, m1, m2]

    for n in nodes:
        if id(n) in done:
            continue
        t, ins, at = n.op_type, list(n.input), attrs(n)
        out = n.output[0]
        if t == "Shape":
            assert ins[0] == inp and at.get("start", 0) == 0 and at.get("end") == 1
            shapes[out] = [-1]
        elif t == "Concat" and all(i in shapes or i in consts for i in ins):
            shapes[out] = sum((shapes[i] if i in shapes else [int(v) for v in consts[i].reshape(-1)] for i in ins), [])
        elif t in ("Add", "Sub", "Mul", "Div") and all(i in consts for i in ins):
            consts[out] = {"Add": np.add, "Sub": np.subtract, "Mul": np.multiply, "Div": np.divide}[t](consts[ins[0]], consts[ins[1]])
        elif t in ("Add", "Sub", "Mul", "Div") and (ins[0] in consts) != (ins[1] in consts):
            chain = match_gelu(n)
            if chain:
                a = acts[ins[0]]
                emit("gelu", chain[-1].output[0], a["perm"], a["lshape"], x=a["id"])
                done.update(id(c) for c in chain)
                continue
            ai = 0 if ins[0] in acts else 1
            c = consts[ins[1 - ai]]
            assert not (ai == 1 and t in ("Sub", "Div")), "const - x / const / x not supported"
            fold_elementwise(n, ins[ai], c, t.lower())
        elif t in ("Add", "Mul", "Sub", "Div"):
            a, b = acts[ins[0]], acts[ins[1]]
            if a["perm"] != b["perm"]:
                a, b = materialize(ins[0]), materialize(ins[1])
            la, lb = a["lshape"], b["lshape"]
            la, lb = [1] * (len(lb) - len(la)) + la, [1] * (len(la) - len(lb)) + lb
            ls = [x if y == 1 else y for x, y in zip(la, lb)]
            emit(t.lower(), out, a["perm"], ls, a=a["id"], b=b["id"])
        elif t == "Conv":
            a = acts[ins[0]]
            assert a["perm"] == (0, 2, 3, 1)
            w = consts[ins[1]]
            b = consts[ins[2]] if len(ins) > 2 else None
            grp = at.get("group", 1)
            pads, strides = at["pads"], at["strides"]
            assert len(set(pads)) == 1 and strides[0] == strides[1] and at.get("dilations", [1, 1]) == [1, 1]
            co, ci, kh, kw = w.shape
            if grp == 1:
                wt, dw = w.transpose(2, 3, 1, 0), False
            else:
                assert grp == co and ci == 1, "only depthwise grouped conv supported"
                wt, dw = w[:, 0].transpose(1, 2, 0)[..., None], True
            ls = list(a["lshape"])
            H = (ls[2] + 2 * pads[0] - kh) // strides[0] + 1
            W = (ls[3] + 2 * pads[0] - kw) // strides[0] + 1
            emit("conv", out, (0, 2, 3, 1), [-1, co, H, W], x=a["id"], w=tkey(wt, "w"),
                 b=tkey(b, "b") if b is not None else None, stride=int(strides[0]), pad=int(pads[0]), dw=dw, act="linear")
            r = only_consumer(out)
            if r is not None and r.op_type == "Relu":
                acts[out]["op"]["act"] = "relu"
                acts[r.output[0]] = acts[out]
                done.add(id(r))
        elif t == "Relu":
            a = acts[ins[0]]
            emit("relu", out, a["perm"], a["lshape"], x=a["id"])
        elif t == "BatchNormalization":
            a = acts[ins[0]]
            sc, bi, mu, var = (consts[i] for i in ins[1:5])
            s = sc / np.sqrt(var + at.get("epsilon", 1e-5))
            emit("affine", out, a["perm"], a["lshape"], x=a["id"],
                 s=tkey(stored_const(s.reshape(-1, 1, 1), a), "s"), b=tkey(stored_const((bi - mu * s).reshape(-1, 1, 1), a), "b"))
        elif t == "Reshape":
            a = acts[ins[0]]
            tgt = shapes[ins[1]] if ins[1] in shapes else [int(v) for v in consts[ins[1]]]
            ls = a["lshape"]
            if a["perm"] == (0, 2, 3, 1) and len(tgt) == 3 and tgt[:2] == ls[:2]:
                n_ = tgt[2]
                assert n_ == ls[2] * ls[3]
                emit("reshape", out, (0, 2, 1), [-1, ls[1], n_], x=a["id"], shape=[-1, n_, ls[1]])
            elif a["perm"] == (0, 2, 1) and len(tgt) == 4 and tgt[:2] == ls[:2]:
                assert tgt[2] * tgt[3] == ls[2]
                emit("reshape", out, (0, 2, 3, 1), [-1, ls[1], tgt[2], tgt[3]], x=a["id"], shape=[-1, tgt[2], tgt[3], ls[1]])
            else:
                a = materialize(ins[0])
                emit("reshape", out, range(len(tgt)), tgt, x=a["id"], shape=tgt)
        elif t == "Transpose":
            a = acts[ins[0]]
            p = at["perm"]
            inv = [int(i) for i in np.argsort(p)]
            acts[out] = {**a, "perm": tuple(inv[i] for i in a["perm"]), "lshape": [a["lshape"][i] for i in p]}
        elif t in ("MatMul", "Gemm"):
            a = materialize(ins[0])
            w = consts[ins[1]]
            if t == "Gemm":
                assert at.get("transA", 0) == 0 and at.get("alpha", 1.0) == 1.0 and at.get("beta", 1.0) == 1.0
                if at.get("transB", 0):
                    w = w.T
            b = consts[ins[2]] if t == "Gemm" and len(ins) > 2 else None
            K = w.shape[1]
            op = emit("matmul", out, a["perm"], a["lshape"][:-1] + [K], x=a["id"], w=tkey(w, "w"),
                      b=tkey(b, "b") if b is not None else None)
            r = only_consumer(out)
            if t == "MatMul" and r is not None and r.op_type == "Add" and r.input[0] == out and r.input[1] in consts \
                    and consts[r.input[1]].shape == (K,):
                op["b"] = tkey(consts[r.input[1]], "b")
                acts[r.output[0]] = acts[out]
                done.add(id(r))
        elif t == "ReduceL2":
            # ReduceL2 -> Clip(min) -> Expand -> Div(x, .)  ==  F.normalize
            a = acts[ins[0]]
            ax = [int(v) for v in consts[ins[1]]]
            assert len(ax) == 1 and at.get("keepdims", 1) == 1
            c = only_consumer(out)
            e = c and c.op_type == "Clip" and only_consumer(c.output[0])
            d = e and e.op_type == "Expand" and only_consumer(e.output[0])
            assert d and d.op_type == "Div" and d.input[0] == ins[0], "unsupported ReduceL2 use"
            eps = scalar(c.input[1])
            r = len(a["perm"])
            sax = a["perm"].index(ax[0] % r)
            emit("l2norm", d.output[0], a["perm"], a["lshape"], x=a["id"], axis=sax, eps=eps)
            done.update({id(c), id(e), id(d)})
        elif t in ("ReduceSum", "ReduceMean"):
            a = acts[ins[0]]
            ax = [int(v) % len(a["perm"]) for v in consts[ins[1]]]
            keep = at.get("keepdims", 1) == 1
            sax = sorted(a["perm"].index(x) for x in ax)
            if keep:
                perm, ls = a["perm"], [1 if i in ax else d for i, d in enumerate(a["lshape"])]
            else:
                rem = [p for p in a["perm"] if p not in ax]
                order = sorted(rem)
                perm = tuple(order.index(p) for p in rem)
                ls = [d for i, d in enumerate(a["lshape"]) if i not in ax]
            emit("sum" if t == "ReduceSum" else "mean", out, perm, ls, x=a["id"], axes=sax, keep=keep)
        elif t == "Softmax":
            a = materialize(ins[0])
            assert at.get("axis", -1) in (-1, len(a["perm"]) - 1)
            emit("softmax", out, a["perm"], a["lshape"], x=a["id"])
        else:
            raise SystemExit(f"unsupported op {t} {ins}")

    res = materialize(g.output[0].name)

    # GELU folding: conv -> gelu -> conv  becomes  conv*(1/sqrt2) -> z*(1+erf(z)) -> conv*(1/sqrt2)  (exact)
    uses = {}
    for op in ops:
        for k in ("x", "a", "b"):
            if isinstance(op.get(k), int):
                uses.setdefault(op[k], []).append(op)
    by_out = {op["out"]: op for op in ops}
    r2 = np.float32(2 ** -0.5)
    for op in ops:
        if op["op"] != "gelu":
            continue
        prev, nxt = by_out.get(op["x"]), uses.get(op["out"], [])
        if not (prev and prev["op"] == "conv" and prev["act"] == "linear" and len(uses[op["x"]]) == 1
                and len(nxt) == 1 and nxt[0]["op"] == "conv" and nxt[0]["x"] == op["out"]):
            continue
        tensors[prev["w"]] = tensors[prev["w"]] * r2
        if prev.get("b"):
            prev["b"] = tkey(tensors[prev["b"]] * r2, "b")
        nk = tkey(tensors[nxt[0]["w"]] * r2, "w")
        nxt[0]["w"] = nk
        op["op"] = "gelu_s"  # z * (1 + erf(z)), input pre-scaled by 1/sqrt2, output scale folded downstream
    # liveness: free each value after its last use
    last = {}
    for i, op in enumerate(ops):
        for k in ("x", "a", "b"):
            if isinstance(op.get(k), int):
                last[op[k]] = i
    for i, op in enumerate(ops):
        op["free"] = sorted({v for k in ("x", "a", "b") if isinstance((v := op.get(k)), int) and last.get(v) == i and v != res["id"]})

    # pack weights
    blob = bytearray()
    meta = {}
    used = {op[k] for op in ops for k in ("w", "s", "b") if isinstance(op.get(k), str)}
    for k in sorted(used, key=lambda s: int(s[1:].split("_")[0])):
        a = tensors[k]
        ent = {"shape": list(a.shape)}
        big = k.endswith("_w") and a.size >= QMIN
        mode = qmode
        if qmode == "mixed":  # int8 for the large stage-3/2 matrices, f16 for the small sensitive ones
            mode = "int8" if a.size >= QMIX else "f16"
        while len(blob) % 4:
            blob.append(0)
        if big and mode == "int8":
            ax = 2 if (a.ndim == 4 and a.shape[3] == 1) else a.ndim - 1
            mx = np.abs(np.moveaxis(a, ax, -1).reshape(-1, a.shape[ax])).max(0)
            sc = np.where(mx > 0, mx / 127.0, 1.0).astype(np.float32)
            shp = [1] * a.ndim
            shp[ax] = -1
            q = np.clip(np.rint(a / sc.reshape(shp)), -127, 127).astype(np.int8)
            ent.update(dtype="int8", axis=ax, scales=len(blob))
            blob += sc.tobytes()
            ent["offset"] = len(blob)
            blob += q.tobytes()
        elif big and mode == "f16":
            ent.update(dtype="f16", offset=len(blob))
            blob += a.astype(np.float16).tobytes()
        else:
            ent.update(dtype="f32", offset=len(blob))
            blob += a.astype(np.float32).tobytes()
        meta[k] = ent
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "weights.bin").write_bytes(bytes(blob))
    spec = {
        "format": "clicksafe-nhwc-1",
        "name": "image-safety-classifier-xs",
        "source": "https://huggingface.co/OwenElliott/image-safety-classifier-xs (onnx/image-safety-classifier-xs.onnx)",
        "labels": ["NSFL", "NSFW", "SFW"],
        "input": {"id": 0, "shape": [-1, 224, 224, 3], "range": [0, 255], "layout": "NHWC RGB"},
        "output": res["id"],
        "weights": {"file": "weights.bin", "bytes": len(blob), "quant": qmode},
        "tensors": meta,
        "ops": ops,
    }
    (out_dir / "model.json").write_text(json.dumps(spec, separators=(",", ":")))
    from collections import Counter
    print("ops", len(ops), dict(Counter(o["op"] for o in ops)), "weights", len(blob))


if __name__ == "__main__":
    q = sys.argv[sys.argv.index("--q") + 1] if "--q" in sys.argv else "mixed"
    main(sys.argv[1], sys.argv[2], q)
