# Bounded native source observation

The optional native task trace can fill its existing buffer during the full
source experiment. A smaller diagnostic collection should retain complete
metadata without increasing the buffer, file, read, loss or retirement limits.

Only the existing isolated eight-second source task diagnostic may request a
two-second observation window. Start its independent timer after observation
begins; keep the main source, pause and offline driver unchanged. At that timer,
collect the existing remaining clock marks and end native trace collection.
Hold the resulting stream until the whole source and actual PCM retirement
finish, then read and parse it. The original single 15-second retirement budget
starts when collection closes and includes that deferral. Every caller joins
the same finish operation. Failures still retire the stream and session.

All seven prescribed marks, fixed coordinate conversion and explicit loss-free
receipt remain required. A partial trace describes only its actual retained
interval. It does not qualify an unobserved native interval, the whole source,
product recording, another duration or another platform. The whole eight-second
source experiment still runs its original checks and retains its actual result.
