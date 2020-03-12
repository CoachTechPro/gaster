const InputDataDecoder = require('ethereum-input-data-decoder');
const fs = require('fs');
const isValid = require('is-valid-path');
const { parseAsync } = require('json2csv');
const { createLogger, format, transports } = require('winston');
const etherscan = require('./etherscan.api');
const dataFeaturing = require('./data.featuring');

const logger = createLogger({
    level: 'info',
    format: format.combine(
        format.timestamp({
            format: 'YYYY-MM-DD HH:mm:ss'
        }),
        format.errors({ stack: true }),
        format.splat(),
        format.json()
    ),
    defaultMeta: { service: 'ethgasstats' },
    transports: [
        new transports.File({ filename: 'ethgasstats-error.log', level: 'error' }),
        new transports.File({ filename: 'ethgasstats-combined.log' })
    ]
});

const validateContractAddress = async (options) => {
    let result = {
        validated: true,
        err: ''
    };

    const response = await etherscan.validateContractAddress(options);

    if (response.error) {
        result.err = 'Address specified is invalid';
        result.validated = false;
    }

    if (response.result === '0x') {
        result.err = 'Address specified is for External Owned Account';
        result.validated = false;
    }

    return result;
};

const getTxInfo = async (options) => {
    let txs = await etherscan.getTxInfo(options);

    return txs.filter((tx) => tx.isError === '0' && undefined !== tx.to && tx.to.toLowerCase() === options.address.toLowerCase());
};

const getITxInfo = async (options) => {
    let itxs = await etherscan.getITxInfo(options);

    return itxs.filter((tx) => tx.isError === '0' && tx.type === 'delegatecall');
};

const mergeTxInfo = (txs, itxs) => {
    let mergedTxs = [...txs];
    itxs.forEach((itx) => {
        const tx = mergedTxs.find(tx => tx.hash === itx.hash);
        if (undefined !== tx) {
            tx.contractAddress = itx.to;
        }
    });

    mergedTxs.forEach((tx) => {
        if(!tx.contractAddress) {
            tx.contractAddress = tx.to;
        }
    });

    return mergedTxs;
};

const getAdresses = (txs) => {
    let addresses = new Set();
    txs.forEach((tx) => {
        if (!addresses.has(tx.contractAddress.toLowerCase())) {
            addresses.add(tx.contractAddress.toLowerCase());
        }
    });

    return addresses;
}

const getAbis = async (options, addresses) => {
    let resultAbis = new Map();
    if (options.abi) {

        if(isValid(options.abi)) {
            try {
                options.abi = fs.readFileSync(options.abi);
            } catch (err) {
                logger.error(`Error occurred on reading abi file: ${err}`);
                options.abi = '[]';
            }
        }

        const abis = JSON.parse(options.abi);
        if (abis.length === 1 && !abis[0].address) {
            const decoder = (() => {
                try {
                    return new InputDataDecoder(abis);
                } catch(err) {
                    logger.error(new Error(`Error occurred on creating txs' input data decoder for address ${options.address}: ${err}`));
                    return undefined;
                }
            })();
            resultAbis.set(options.address.toLowerCase(), {
                abi: abis,
                decoder
            });
        } else {
            abis.forEach(item => {
                const decoder = (() => {
                    try {
                        return new InputDataDecoder(item.abi);
                    } catch(err) {
                        logger.error(new Error(`Error occurred on creating txs' input data decoder for address ${item.address}: ${err}`));
                        return undefined;
                    }
                })();
                resultAbis.set(item.address.toLowerCase(), {
                    abi: item.abi,
                    decoder
                });
            })
        }
    }

    let promises = [];

    addresses.forEach(async (address) => {
        if (resultAbis.has(address.toLowerCase())) {
            return;
        }
       
        promises.push(new Promise((resolve, reject) => getAbi(address, options.ropsten)
            .then(async (result) => {
                if (result.err) {
                    result.abi = '[]';
                    logger.error(new Error(`Error occurred on getting contract ${address} abi: ${result.err}`));
                }
                const abi = JSON.parse(result.abi);
                const decoder = (() => {
                    try {
                        return new InputDataDecoder(abi);
                    } catch(err) {
                        logger.error(new Error(`Error occurred on creating txs' input data decoder for address ${address}: ${err}`));
                        return undefined;
                    }
                })();
                resultAbis.set(address, {
                    abi,
                    decoder
                });
                resolve();
            })
            .catch(err => {
                logger.error(new Error(`Error occurred on getting contract ${address} abi: ${err}`));
            })));
    });

    await Promise.all(promises);

    return resultAbis;
};

const getAbi = async (address, testnet) => {
    let result = {
        abi: '[]',
        err: ''
    };

    const response = await etherscan.getAbi(testnet, address);

    result.abi = response.result;

    if (response.error) {
        result.err = response.error;
        result.abi = '[]';
    }

    if (response.message === 'NOTOK') {
        result.err = response.result;
        result.abi = '[]';
    }

    return result;
};

const prepareTxsData = async function (options, txs, abis) {
    let preparedTxs = [...txs];
    let features = [];
    preparedTxs.forEach((tx) => {
        const item = abis.get(tx.contractAddress.toLowerCase());
        if (item && item.decoder) {
            tx.input = item.decoder.decodeData(tx.input);
            tx['properties'] = tx.input.names.reduce(function(properties, name, index){
                properties[`arg_${name}`] = tx.input.inputs[index];
                return properties;
            }, {});
            tx['features'] = getFeatures(tx, tx.input);
            tx.inputs = tx.input.inputs;
            tx.method = tx.input.method;
            tx.types = tx.input.types;
            tx.names = tx.input.names;
        }
    });
    if (options.trace) {
        features.push('arg__organization_timeStamp');
        const distinctOrganizations = [...new Set(preparedTxs.map(tx => `0x${tx['arg__organization'].toLowerCase()}`))];
        const organizationsCreationDates = await distinctOrganizations.reduce(async (pendingResult, organizationAddress) => {
            const previousResult = await pendingResult;
            const creationDate = await getContractCreationDate(organizationAddress, options);
            const result = {
                [organizationAddress]: creationDate,
                ...previousResult
            };
            return result
        }, {});
        preparedTxs.forEach(tx => tx['arg__organization_timeStamp'] = Number(organizationsCreationDates[`0x${tx['arg__organization'].toLowerCase()}`]))
    }

    return preparedTxs;
};

const getFeatures = (data, input) => {
    return dataFeaturing.getFeatures(input, data);
};

const persistTxsData = async function (options, txs, features) {
    if (!txs.length) {
        throw new Error(`There is no transactions to process`);
    }
    
    const fields = [
        {
            label: 'address',
            value: 'to',
            default: 'NULL'
        },
        {
            label: 'blockNumber',
            value: (row, field) => Number(row[field.label]),
            default: 'NULL'
        },
        {
            label: 'gasUsed',
            value: (row, field) => Number(row[field.label]),
            default: 'NULL'
        },
        {
            label: 'gasPrice',
            value: (row, field) => Number(row[field.label]),
            default: 'NULL'
        },
        {
            label: 'gas',
            value: (row, field) => Number(row[field.label]),
            default: 'NULL'
        },
        'from',
        'input',
        'method',
        'types',
        'inputs',
        'names',
        'hash',
        {
            label: 'timeStamp',
            value: (row, field) => Number(row[field.label]),
            default: 'NULL'
        },
        'properties',
        ...new Set(txs.reduce((arr, tx) => {
            arr.push(...tx.features);
            return arr;
        },[]))
    ];
    const opts = { fields };
    let promises = [];

    try {
        const chunk = 1000;
        const quantity = Math.ceil(txs.length / chunk);
        for (let i = 0; i < quantity; ++i) {
            const ttxs = txs.slice(i * chunk, (i + 1) * chunk);

            const fname = `${options.address}_${i}.csv`;
            const fpath = `${options.path ? options.path : process.cwd()}/${fname}`;

            promises.push(new Promise((resolve, reject) => parseAsync(ttxs, opts)
                .then(async (csv) => {
                    let writeStream = fs.createWriteStream(fpath);
                    writeStream.write(csv, 'utf-8');

                    writeStream.on('finish', () => {
                        resolve();
                    });

                    writeStream.end();
                })
                .catch(err => {
                    reject(`An error occurred on txs data processing to csv: ${err}; file: ${fpath}`);
                })));

            await Promise.all(promises);
        }
    } catch (err) {
        throw new Error(`An error occurred on data persisting: ${err}`);
    }
};

const getContractCreationDate = async function (address, options) {
    const response = await etherscan.getContractCreationDate(options, address);

    if (!response.result.length) {
        return 0
    }
    const result = response.result[0];
    return result.timeStamp
};

module.exports = { 
    validateContractAddress,
    getTxInfo,
    getITxInfo,
    mergeTxInfo,
    getAdresses,
    getAbis,
    prepareTxsData,
    getFeatures,
    persistTxsData
};