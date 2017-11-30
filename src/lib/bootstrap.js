import isFunction from 'lodash/isFunction';
import assign from 'lodash/assign';
import Path from 'path';
import URL from 'url';
import fs from 'fs';
import http from'http';
import https from 'https';
import constants from 'constants';
import chalk from 'chalk';

const server = require('../api/index');
const Utils = require('./utils');
const logger = require('./logger');

/**
 * Retrieve all addresses defined in the config file.
 * Verdaccio is able to listen multiple ports
 * @param {String} argListen
 * @param {String} configListen
 * eg:
 *  listen:
    - localhost:5555
    - localhost:5557
    @return {Array}
 */
function getListListenAddresses(argListen, configListen) {
  // command line || config file || default
  let addresses;
  if (argListen) {
    addresses = [argListen];
  } else if (Array.isArray(configListen)) {
    addresses = configListen;
  } else if (configListen) {
    addresses = [configListen];
  } else {
    addresses = ['4873'];
  }
  addresses = addresses.map(function(addr) {
    const parsed_addr = Utils.parse_address(addr);

    if (!parsed_addr) {
      logger.logger.warn({addr: addr},
         'invalid address - @{addr}, we expect a port (e.g. "4873"),'
       + ' host:port (e.g. "localhost:4873") or full url'
       + ' (e.g. "http://localhost:4873/")');
    }

    return parsed_addr;
  }).filter(Boolean);

  return addresses;
}

/**
 * Trigger the server after configuration has been loaded.
 * @param {Object} config
 * @param {Object} cliArguments
 * @param {String} configPath
 * @param {String} pkgVersion
 * @param {String} pkgName
 */
function startVerdaccio(config, cliListen, configPath, pkgVersion, pkgName, callback) {
  if (!config.self_path) {
    config.self_path = Path.resolve(configPath);
  }
  if (!config.https) {
    config.https = {enable: false};
  }

  const app = server(config);
  const addresses = getListListenAddresses(cliListen, config.listen);

  addresses.forEach(function(addr) {
    let webServer;
    if (addr.proto === 'https') {
      // https  must either have key cert and ca  or a pfx and (optionally) a passphrase
      if (!config.https || !config.https.key || !config.https.cert || !config.https.ca) {
        displayHTTPSWarning(configPath);
      }

      webServer = handleHTTPS(app, configPath);
    } else { // http
      webServer = http.createServer(app);
    }

    unlinkAddressPath(addr);

    callback(webServer, addr, pkgName, pkgVersion);
  });

  // undocumented stuff for tests
  if (isFunction(process.send)) {
    process.send({
      verdaccio_started: true,
    });
  }
}

function unlinkAddressPath(addr) {
  if (addr.path && fs.existsSync(addr.path)) {
    fs.unlinkSync(addr.path);
  }
}

function displayHTTPSWarning(configPath) {
  const resolveConfigPath = function(file) {
    return Path.resolve(Path.dirname(configPath), file);
  };

  logger.logger.fatal([
    'You have enabled HTTPS and need to specify either ',
    '    "https.key", "https.cert" and "https.ca" or ',
    '    "https.pfx" and optionally "https.passphrase" ',
    'to run https server',
    '',
    // commands are borrowed from node.js docs
    'To quickly create self-signed certificate, use:',
    ' $ openssl genrsa -out ' + resolveConfigPath('verdaccio-key.pem') + ' 2048',
    ' $ openssl req -new -sha256 -key ' + resolveConfigPath('verdaccio-key.pem') + ' -out ' + resolveConfigPath('verdaccio-csr.pem'),
    ' $ openssl x509 -req -in ' + resolveConfigPath('verdaccio-csr.pem') +
    ' -signkey ' + resolveConfigPath('verdaccio-key.pem') + ' -out ' + resolveConfigPath('verdaccio-cert.pem'),
    '',
    'And then add to config file (' + configPath + '):',
    '  https:',
    '    key: verdaccio-key.pem',
    '    cert: verdaccio-cert.pem',
    '    ca: verdaccio-cert.pem',
  ].join('\n'));
  process.exit(2);
}

function handleHTTPS(app, configPath) {
  try {
    let httpsOptions = {
      secureProtocol: 'SSLv23_method', // disable insecure SSLv2 and SSLv3
      secureOptions: constants.SSL_OP_NO_SSLv2 | constants.SSL_OP_NO_SSLv3,
    };

    if (config.https.pfx) {
      httpsOptions = assign(httpsOptions, {
        pfx: fs.readFileSync(config.https.pfx),
        passphrase: config.https.passphrase || '',
      });
    } else {
      httpsOptions = assign(httpsOptions, {
        key: fs.readFileSync(config.https.key),
        cert: fs.readFileSync(config.https.cert),
        ca: fs.readFileSync(config.https.ca),
      });
    }
    return https.createServer(httpsOptions, app);
  } catch (err) { // catch errors related to certificate loading
    logger.logger.fatal({err: err}, 'cannot create server: @{err.message}');
    process.exit(2);
  }
}

function listenDefaultCallback(webServer, addr, pkgName, pkgVersion) {
  webServer.listen(addr.port || addr.path, addr.host).on('error', function(err) {
    logger.logger.fatal({err: err}, 'cannot create server: @{err.message}');
    process.exit(2);
  });

  logger.logger.warn({
    addr: ( addr.path
          ? URL.format({
              protocol: 'unix',
              pathname: addr.path,
            })
          : URL.format({
              protocol: addr.proto,
              hostname: addr.host,
              port: addr.port,
              pathname: '/',
            })
          ),
    version: pkgName + '/' + pkgVersion,
  }, 'http address - @{addr} - @{version}');
}

export {startVerdaccio, listenDefaultCallback};
