import { Stack, HStack, Badge } from "@chakra-ui/react";
import { DataDisplay } from "./DataDisplay";
import { Field } from "../types";

export function RepeatedFieldDisplay({ fields }: { fields: Field[] }) {
  return (
    <Stack w="full" spacing={2} align="stretch">
      <HStack>
        <Badge colorScheme="green">Repeated Type: {fields[0].type}</Badge>
        <Badge colorScheme="blue">Repeated {fields.length}</Badge>
      </HStack>
      {fields.map((field, idx) => (
        <DataDisplay key={idx} field={field} />
      ))}
    </Stack>
  );
}
