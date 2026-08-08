interface RequiredIdentifier {
  readonly id: string;
}

// @ts-expect-error This fixture proves that negative compile contracts remain enforced.
const invalidIdentifier: RequiredIdentifier = { id: 42 };

void invalidIdentifier;
