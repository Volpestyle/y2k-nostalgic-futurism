export type NpyArray = {
  data: Float32Array;
  shape: number[];
};

const MAGIC = "\x93NUMPY";

const parseHeader = (raw: string) => {
  const descr = /'descr':\s*'([^']+)'/.exec(raw)?.[1] ?? "";
  const shapeText = /'shape':\s*\(([^)]*)\)/.exec(raw)?.[1] ?? "";
  const shape = shapeText
    .split(",")
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isFinite(value));
  const fortran = /'fortran_order':\s*(True|False)/.exec(raw)?.[1] === "True";
  return { descr, shape, fortran };
};

export const parseNpyFloat32 = (buffer: ArrayBuffer): NpyArray => {
  const magic = new Uint8Array(buffer, 0, 6);
  if (String.fromCharCode(...magic) !== MAGIC) {
    throw new Error("Invalid .npy file");
  }

  const view = new DataView(buffer);
  const major = view.getUint8(6);
  const minor = view.getUint8(7);
  if (major !== 1 && major !== 2) {
    throw new Error(`Unsupported .npy version ${major}.${minor}`);
  }

  const headerLength = major === 1 ? view.getUint16(8, true) : view.getUint32(8, true);
  const headerOffset = major === 1 ? 10 : 12;
  const headerRaw = new TextDecoder().decode(
    new Uint8Array(buffer, headerOffset, headerLength)
  );
  const { descr, shape, fortran } = parseHeader(headerRaw);
  if (fortran) {
    throw new Error("Fortran-ordered arrays are not supported");
  }

  const length = shape.reduce((acc, value) => acc * value, 1);
  const dataOffset = headerOffset + headerLength;

  if (descr === "<f4" || descr === "|f4") {
    return { data: new Float32Array(buffer, dataOffset, length), shape };
  }

  if (descr === ">f4") {
    const data = new Float32Array(length);
    const bytes = new DataView(buffer, dataOffset);
    for (let i = 0; i < length; i += 1) {
      data[i] = bytes.getFloat32(i * 4, false);
    }
    return { data, shape };
  }

  throw new Error(`Unsupported dtype ${descr || "unknown"}`);
};
