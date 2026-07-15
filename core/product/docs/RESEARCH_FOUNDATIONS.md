# Atlas Research Foundations

Status: canonical product-origin and research-provenance record

Atlas began as an independently developed response to the limits of an earlier,
rudimentary memory and retrieval workflow. The initial product idea came from
working through that problem directly: reduce unfocused context gathering,
preserve repository-owned knowledge, make retrieved evidence inspectable, and
support deliberate traversal from a broad repository concern to its governing
sources.

Research review began later, when the idea moved into proof-of-concept work.
The papers below did not originate Atlas. They gave the emerging product useful
vocabulary, sharper architectural distinctions, and established ideas against
which the proof of concept could be tested. In short: independent ideation gave
Atlas its start; research gave the implementation shape.

## Ideas Established Before The Research Review

The pre-research direction already treated these as product needs:

- memory and source authority belong to the consuming repository;
- an agent should narrow attention before broadly opening files;
- retrieval should return inspectable source evidence rather than an opaque
  answer;
- traversal should move from higher-level product or repository context toward
  local implementation detail; and
- visualization may help explore the same knowledge, but it must not become the
  authority for that knowledge.

These statements record Atlas product provenance. They are not claims that the
underlying techniques were historically unprecedented or invented in academic
isolation.

## Confirmed Proof-Of-Concept Research Influences

### ReAct

Shunyu Yao et al., *ReAct: Synergizing Reasoning and Acting in Language Models*,
[arXiv:2210.03629](https://arxiv.org/abs/2210.03629).

ReAct helped shape the later separation and ordering of route selection,
reasoning, evidence retrieval, source inspection, and action. Atlas applies
that influence through an evidence-first agent workflow in which a repository's
own task route remains authoritative.

Atlas is not a ReAct implementation. It does not reproduce the paper's prompts,
training, benchmarks, or agent loop, and ReAct was not the source of the Atlas
product idea.

### Self-RAG

Akari Asai et al., *Self-RAG: Learning to Retrieve, Generate, and Critique
through Self-Reflection*,
[arXiv:2310.11511](https://arxiv.org/abs/2310.11511).

Self-RAG gave later support and vocabulary to the idea that retrieval should be
adaptive rather than an obligatory fixed step. It also informed the decision to
make retrieval quality inspectable before an agent relies on it. Atlas expresses
that distinction through explicit Evidence v2 states and source verification.

Atlas does not train or use Self-RAG reflection tokens and does not claim to
implement Self-RAG. Its current evidence projection and quality states are
deterministic product contracts.

### GraphRAG

Darren Edge et al., *From Local to Global: A Graph RAG Approach to Query-Focused
Summarization*,
[arXiv:2404.16130](https://arxiv.org/abs/2404.16130).

GraphRAG helped sharpen the later distinction between global sensemaking and
local retrieval. That distinction influenced Atlas Product's separation of the
repository-local retrieval path from Atlas Graph's optional broader visual
lens.

Atlas Graph is not Microsoft GraphRAG's entity-extraction, community-detection,
or community-summary pipeline. It renders provider-owned repository
architecture projections and does not replace repository source authority.

### Hierarchical Navigable Small World Graphs

Yu. A. Malkov and D. A. Yashunin, *Efficient and Robust Approximate Nearest
Neighbor Search Using Hierarchical Navigable Small World Graphs*,
[arXiv:1603.09320](https://arxiv.org/abs/1603.09320).

HNSW provided a useful later structural analogy: begin with sparse,
higher-level entry points, then descend into a denser local neighborhood. Atlas
uses that analogy in route and Architecture-room traversal, where a broad entry
narrows toward source evidence.

Atlas does not currently implement an HNSW approximate-nearest-neighbor index.
Atlas Core's present local vector layer uses deterministic hash-derived vectors
stored in SQLite alongside lexical retrieval.

## Later Repository-Learning Review

The following work was reviewed after arbitrary-repository trials showed that
directory and symbol inventories can look precise while still failing to
explain a repository as a system. These sources validated and refined the later
repository-learning boundary; they did not originate Atlas or its proof of
concept.

### RepoCoder

Fengji Zhang et al., *RepoCoder: Repository-Level Code Completion Through
Iterative Retrieval and Generation*,
[arXiv:2303.12570](https://arxiv.org/abs/2303.12570).

RepoCoder reinforced the value of repository-wide context selection and an
iterative relationship between retrieval and generation. Atlas applies that
influence narrowly: `atlas map` selects a bounded, source-diverse orientation
packet before a generation provider proposes a cited repository system model.

Atlas does not implement RepoCoder's code-completion task, iterative retrieval
algorithm, prompts, training, benchmarks, or evaluation. RepoCoder is a later
design influence, not the origin of Atlas or an implementation dependency.

### RepoGraph

Siru Ouyang et al., *RepoGraph: Enhancing AI Software Engineering with
Repository-level Code Graph*,
[arXiv:2410.14684](https://arxiv.org/abs/2410.14684).

RepoGraph supported the later decision to retain deterministic repository-wide
relationships as orientation and navigation evidence instead of treating each
file as an isolated unit. Atlas keeps that structural evidence separate from
the generated responsibility-level semantic model.

Atlas does not implement RepoGraph's repository graph construction, agent
plugin, context-selection algorithm, experiments, or benchmark results. The
paper did not originate Atlas and is not an embedded product dependency.

### Integrated Structural, Semantic, And Directory Recovery

Shiva Prasad Reddy Puchala, Jitender Kumar Chhabra, and Amit Rathee, *Software
Architecture Recovery Using Integrated Dependencies Based on Structural,
Semantic, and Directory Information*, 2022,
[DOI:10.4018/IJISMD.297060](https://doi.org/10.4018/IJISMD.297060).

This work validated the later architectural distinction between raw structural
and directory evidence and a separate semantic synthesis. It also reinforced
the principle that no single observed signal is sufficient to recover a
system-level explanation.

Atlas does not reproduce the paper's dependency weighting, semantic analysis,
clustering method, recovered-view algorithm, or evaluation. It is a later
comparison and design influence, not evidence that Atlas implements the
published recovery technique.

## Provenance And Citation Policy

Atlas documentation distinguishes three kinds of statement:

1. **Product origin** records the independently developed problem, product idea,
   and early design direction.
2. **Research influence** records a source reviewed during or after proof-of-
   concept work that shaped vocabulary, boundaries, implementation choices, or
   validation.
3. **Implementation dependency** records an algorithm or external component
   actually implemented, embedded, or required by Atlas.

The four works in **Confirmed Proof-Of-Concept Research Influences** shaped the
proof of concept. The three works in **Later Repository-Learning Review** are
later design influences or validation. None may be described as the origin of
Atlas or as an implemented dependency. Additional literature may be added when
a durable design record establishes when and how it affected the product.
Contextual reading discovered later must remain labeled as later validation or
comparison rather than being retroactively promoted to an original influence.

This file records what shaped Atlas. A future `CITATION.cff`, if added, has a
different job: it tells other people how to cite an Atlas release.
