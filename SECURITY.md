# Security

Do not commit credentials, private keys, tokens, consumer memory, generated
indexes, or Atlas Instance State to the Atlas Product distribution.

Generation adapters may receive source content selected by the consumer.
Configure the correct local or remote data boundary, keep credentials in the
process environment, and use `--allow-remote` only after reviewing the selected
sources and the configured provider's privacy terms. Atlas does not persist the
one-call remote grant.

Report security issues privately to the maintainer until a public reporting
address is selected. Include the affected component revision from
`ATLAS_COMPONENTS.json` and omit real consumer data from reproductions.
