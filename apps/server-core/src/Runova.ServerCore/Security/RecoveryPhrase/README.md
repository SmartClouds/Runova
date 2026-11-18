# Recovery phrase words

`english.txt` is the BIP39 English word list, 2048 words, from
https://github.com/bitcoin/bips/blob/master/bip-0039/english.txt (MIT License, Copyright (c) 2013
Pavol Rusnak, Marek Palatinus, Aaron Voisine, Sean Bowe). Its SHA-256 is
`2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda`. It is embedded in the build
so the admin CLI can read a recovery phrase (E107) the way the desktop writes it.
