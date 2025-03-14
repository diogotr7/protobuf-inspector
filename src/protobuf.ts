import { Reader } from "protobufjs";
import { RawField, RawMessage, SizedRawField, WireType } from "./types";

export function decodeBytes(bytes: Uint8Array): RawMessage {
  if (!bytes || bytes.length === 0)
    return { offset: 0, tagSize: 0, dataSize: 0, fields: new Map() };

  return readMessage(new Reader(bytes), 0, bytes.length);
}

export function readMessage(
  reader: Reader,
  headerSize: number,
  dataSize: number
): RawMessage {
  const fields: Map<number, SizedRawField> = new Map();

  const initialPos = reader.pos;
  while (reader.pos < initialPos + dataSize) {
    const [fieldNumber, field] = readField(reader);
    if (!fields.has(fieldNumber)) {
      fields.set(fieldNumber, field);
      continue;
    }

    //if we already have a field with this number. It's a repeated field.
    //Check if we already have a repeated field, if not, create one.
    const existingField = fields.get(fieldNumber)!;
    if (existingField.type === "repeatedField") {
      //TODO: check mismatched types?
      existingField.data.push(field);
    } else {
      //TODO: verify that the existing field is of the same type as the new field?
      fields.set(fieldNumber, {
        type: "repeatedField",
        data: [existingField, field],
        offset: existingField.offset,
        dataSize: existingField.dataSize + field.dataSize,
        tagSize: existingField.tagSize + field.tagSize,
      });
    }
  }

  return {
    offset: initialPos - headerSize,
    tagSize: headerSize,
    dataSize,
    fields,
  };
}

function readField(reader: Reader): [number, SizedRawField] {
  const tagBefore = reader.pos;
  //todo: should this be a uint64 instead?
  const tag = reader.uint32();
  const fieldNumber = tag >>> 3;
  const wireType = tag & 7;
  let tagBytes = reader.pos - tagBefore;
  const dataBefore = reader.pos;

  let field: RawField;
  switch (wireType) {
    case WireType.Varint: {
      const before = reader.pos;
      const int32Representation = reader.int32();
      reader.pos = before;
      const uint32Representation = reader.uint32();
      reader.pos = before;
      const sint32Representation = reader.sint32();
      reader.pos = before;
      const int64Representation = reader.int64();
      reader.pos = before;
      const uint64Representation = reader.uint64();
      reader.pos = before;
      const sint64Representation = reader.sint64();
      reader.pos = before;
      const booleanRepresentation = reader.bool();

      field = {
        data: {
          int32Representation,
          uint32Representation,
          sint32Representation,
          int64Representation,
          uint64Representation,
          sint64Representation,
          booleanRepresentation,
        },
        type: "varint",
      };
      break;
    }
    case WireType.Bit32: {
      const before = reader.pos;
      const uint32Representation = reader.fixed32();
      reader.pos = before;
      const int32Representation = reader.int32();

      field = {
        type: "fixed32",
        data: {
          int32Representation,
          uint32Representation,
        },
      };
      break;
    }
    case WireType.Bit64: {
      const before = reader.pos;
      const uint64Representation = reader.fixed64();
      reader.pos = before;
      const int64Representation = reader.sfixed64();

      field = {
        type: "fixed64",
        data: {
          int64Representation,
          uint64Representation,
        },
      };
      break;
    }
    case WireType.LengthDelimited: {
      field = readLengthDelimited(reader);
      break;
    }
    case WireType.StartGroup: {
      //   reader.skip(WireType.StartGroup);
      //   console.debug("Skipping group.");
      //   //hacky, skip the group and go next
      //   return readField(reader);
      throw new Error("groups are not supported");
    }
    case WireType.EndGroup: {
      throw new Error("groups are not supported");
    }
    default: {
      throw new Error(`unknown wire type ${wireType} ${WireType[wireType]}`);
    }
  }

  const dataBytes = reader.pos - dataBefore;
  return [
    fieldNumber,
    {
      ...field,
      offset: tagBefore,
      tagSize: tagBytes,
      dataSize: dataBytes,
    },
  ];
}

//TODO: make this return a SizedRawField.
// I think we have enough information:
//  the offset is trivial.
//  tag size is just the byte length of the varint
//  data size is the value of the varint

//If the data of the field is a submessage, it will deal with its size itself?
function readLengthDelimited(reader: Reader): RawField {
  //possible data:
  // 1. submessage
  // 2. repeated field
  // 3. string
  // 4. bytes

  // We should try to parse this as the data types described above, in order. If all else fails, just assume bytes.
  const before = reader.pos;
  //read how long the data is first.
  const length = reader.uint32();
  //then, we measure how long this varint header is
  const varIntHeaderLength = reader.pos - before;
  //we do not rewind here, if it *is* a submessage, it assumes we've already read the len varint.

  //if try read tag works, we need to then figure out whether it's a submessage or a repeated field. It's safe to exhaust the buffer, we'll never read past where we should.
  try {
    //TODO: need to deal with packed repeated fields here.
    // as far as i understand, they're a length delimited field, that contains a single tag at the start,
    //  then the actual data of the field repeated until we finish the payload (with no more tags).
    // Checking for its existence without type information is a bit of a pain. Probably force read a tag,
    //  then be more permissive reading following tags within that length delimited payload.
    const data = readMessage(reader, varIntHeaderLength, length);

    //kind of dodgy logic incoming, more of a heuristic than anything else.
    // We try to handle deciding whether it's a submessage or a repeated field as best as we can.
    // If we only have one field, there's no way to tell for sure, we just assume it's a submessage.
    // If there's multiple with the same field number, it has to be a repeated field.
    // If there's multiple with different field numbers, it's a submessage.

    const asArray = Array.from(data.fields.entries());
    if (asArray.length > 1 && asArray.every((f) => f[0] === asArray[0][0])) {
      return {
        type: "repeatedField",
        data: Array.from(data.fields.values()),
      };
    }

    return {
      data: data,
      type: "message",
    };
  } catch (e) {
    reader.pos = before;
    console.debug(
      "Failed parsing message from length delimited field. This is probably not an error. Falling back to string or bytes.",
      e
    );
    //let the other parsers try to parse this.
  }

  console.debug("Trying to parse as string or bytes.");

  //the other two parsers don't really care about a Reader, so we can just pass the bytes.
  const bytes = reader.bytes();

  //if try read tag fails, we need to try to parse it as a string.
  const possibleString = tryReadString(bytes);
  if (possibleString) {
    return {
      data: possibleString,
      type: "string",
    };
  }

  //if that fails, just assume it's bytes.
  return {
    data: bytes,
    type: "bytes",
  };
}

function tryReadString(bytes: Uint8Array): string | null {
  try {
    const string = new TextDecoder("utf-8").decode(bytes);
    //if more than 50% of the bytes are valid ASCII, assume it's a string.
    if (
      string.length > 0 &&
      (string.match(/[ -~]/g)?.length ?? 0) / string.length > 0.5
    ) {
      return string;
    }
    return null;
  } catch (e) {
    console.debug(
      "Failed parsing string from length delimited field. This is probably not an error.",
      e
    );
    return null;
  }
}
