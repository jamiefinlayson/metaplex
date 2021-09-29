import { EXTENSION_PNG } from '../helpers/constants';
import path from 'path';
import {
  createConfig,
  loadCandyProgram,
  loadWalletKey,
} from '../helpers/accounts';
import { PublicKey } from '@solana/web3.js';
import fs from 'fs';
import BN from 'bn.js';
import { loadCache, saveCache } from '../helpers/cache';
import log from 'loglevel';
import { arweaveUpload } from '../helpers/upload/arweave';
import { ipfsCreds, ipfsUpload } from '../helpers/upload/ipfs';
import { chunks } from '../helpers/various';

export async function upload(
  files: string[],
  cacheName: string,
  env: string,
  keypair: string,
  totalNFTs: number,
  storage: string,
  retainAuthority: boolean,
  ipfsCredentials: ipfsCreds,
): Promise<boolean> {
  let uploadSuccessful = true;
  log.info({ keypair });

  const savedContent = loadCache(cacheName, env);
  const cacheContent = savedContent || {};

  if (!cacheContent.program) {
    cacheContent.program = {};
  }

  let existingInCache = [];
  if (!cacheContent.items) {
    cacheContent.items = {};
  } else {
    existingInCache = Object.keys(cacheContent.items);
  }

  const seen = {};
  const newFiles = [];

  files.forEach(f => {
    if (!seen[f.replace(EXTENSION_PNG, '').split('/').pop()]) {
      seen[f.replace(EXTENSION_PNG, '').split('/').pop()] = true;
      newFiles.push(f);
    }
  });
  existingInCache.forEach(f => {
    if (!seen[f]) {
      seen[f] = true;
      newFiles.push(f + '.png');
    }
  });

  const images = newFiles.filter(val => path.extname(val) === EXTENSION_PNG);
  const SIZE = images.length;

  const walletKeyPair = loadWalletKey(keypair);
  const anchorProgram = await loadCandyProgram(walletKeyPair, env);

  let config = cacheContent.program.config
    ? new PublicKey(cacheContent.program.config)
    : undefined;

  for (let i = 0; i < SIZE; i++) {
    const image = images[i];
    const imageName = path.basename(image);
    const index = imageName.replace(EXTENSION_PNG, '');

    log.debug(`Processing file: ${i}`);
    if (i % 50 === 0) {
      log.info(`Processing file: ${i}`);
    }

    let link = cacheContent?.items?.[index]?.link;
    if (!link || !cacheContent.program.uuid) {
      const manifestPath = image.replace(EXTENSION_PNG, '.json');
      const manifestContent = fs
        .readFileSync(manifestPath)
        .toString()
        .replace(imageName, 'image.png')
        .replace(imageName, 'image.png');
      const manifest = JSON.parse(manifestContent);

      const manifestBuffer = Buffer.from(JSON.stringify(manifest));
      const manifestBufferString = JSON.parse(manifestBuffer.toString());

      if (i === 0 && !cacheContent.program.uuid) {
        // initialize config
        log.info(`initializing config`);
        try {
          const maxNumberOfLines = new BN(totalNFTs);
          log.info('maxNumberOfLines', maxNumberOfLines);
          // const symbol = manifest.symbol;
          const symbol = 'TEST';
          log.info('symbol', symbol);
          // const sellerFeeBasisPoints = manifest.seller_fee_basis_points;
          const sellerFeeBasisPoints = 250;
          log.info({ sellerFeeBasisPoints });
          const isMutable = true;
          log.info({ isMutable });
          const maxSupply = new BN(0);
          log.info({ maxSupply });
          // const retainAuthority = retainAuthority;
          log.info({ manifestBufferString });
          const creators = manifestBufferString.properties.creators.map(
            address => {
              log.info({ address });
              const creatorKey = new PublicKey(address);
              const creator = {
                address: creatorKey,
                verified: true,
                share: 0.5,
              };
              return creator;
              // return(
              //  const mappedCreators = manifestBufferString.properties.creators.map(item=>{
              //    //console.log("item goes here",item)
              //      return (item)
              //      //address: item,
              //      //verified: true,
              //      //share: creator.share,
              //  })
              //  return {
              //    address: mappedCreators,
              //    verified: true
              //  }
              //  )
            },
          );
          console.log({ creators: JSON.stringify(creators, null, 2) });
          log.info({ anchorProgram });
          log.info({ walletKeyPair });
          const res = await createConfig(anchorProgram, walletKeyPair, {
            maxNumberOfLines,
            symbol,
            sellerFeeBasisPoints,
            isMutable,
            maxSupply,
            retainAuthority,
            creators,
          });
          log.info(`initialized config`);

          cacheContent.program.uuid = res.uuid;
          cacheContent.program.config = res.config.toBase58();
          config = res.config;

          log.info(
            `initialized config for a candy machine with publickey: ${res.config.toBase58()}`,
          );

          saveCache(cacheName, env, cacheContent);
        } catch (exx) {
          log.error('Error deploying config to Solana network.', exx);
          throw exx;
        }
      }

      if (!link) {
        try {
          if (storage === 'arweave') {
            link = await arweaveUpload(
              walletKeyPair,
              anchorProgram,
              env,
              image,
              manifestBuffer,
              manifest,
              index,
            );
          } else if (storage === 'ipfs') {
            link = await ipfsUpload(ipfsCredentials, image, manifestBuffer);
          }

          if (link) {
            log.debug('setting cache for ', index);
            cacheContent.items[index] = {
              link,
              name: manifest.name,
              onChain: false,
            };
            cacheContent.authority = walletKeyPair.publicKey.toBase58();
            saveCache(cacheName, env, cacheContent);
          }
        } catch (er) {
          uploadSuccessful = false;
          log.error(`Error uploading file ${index}`, er);
        }
      }
    }
  }

  const keys = Object.keys(cacheContent.items);
  try {
    await Promise.all(
      chunks(Array.from(Array(keys.length).keys()), 1000).map(
        async allIndexesInSlice => {
          for (
            let offset = 0;
            offset < allIndexesInSlice.length;
            offset += 10
          ) {
            const indexes = allIndexesInSlice.slice(offset, offset + 10);
            const onChain = indexes.filter(i => {
              const index = keys[i];
              return cacheContent.items[index]?.onChain || false;
            });
            const ind = keys[indexes[0]];

            if (onChain.length != indexes.length) {
              log.info(
                `Writing indices ${ind}-${keys[indexes[indexes.length - 1]]}`,
              );
              try {
                await anchorProgram.rpc.addConfigLines(
                  ind,
                  indexes.map(i => ({
                    uri: cacheContent.items[keys[i]].link,
                    name: cacheContent.items[keys[i]].name,
                  })),
                  {
                    accounts: {
                      config,
                      authority: walletKeyPair.publicKey,
                    },
                    signers: [walletKeyPair],
                  },
                );
                indexes.forEach(i => {
                  cacheContent.items[keys[i]] = {
                    ...cacheContent.items[keys[i]],
                    onChain: true,
                  };
                });
                saveCache(cacheName, env, cacheContent);
              } catch (e) {
                log.error(
                  `saving config line ${ind}-${
                    keys[indexes[indexes.length - 1]]
                  } failed`,
                  e,
                );
                uploadSuccessful = false;
              }
            }
          }
        },
      ),
    );
  } catch (e) {
    log.error(e);
  } finally {
    saveCache(cacheName, env, cacheContent);
  }
  console.log(`Done. Successful = ${uploadSuccessful}.`);
  return uploadSuccessful;
}
