import { X509Certificate } from 'node:crypto'
import fsPromises from 'node:fs/promises'
import fetch from 'node-fetch'
import { debug as Debug } from '../utils/logging.js'

import {
  DEV_VERSION,
  FIL_WALLET_ADDRESS,
  NODE_OPERATOR_EMAIL,
  NODE_VERSION,
  nodeId,
  ORCHESTRATOR_URL, SATURN_NETWORK,
  updateNodeToken
} from '../config.js'
import { getCPUStats, getDiskStats, getMemoryStats, getNICStats, getSpeedtest } from '../utils/system.js'
import { CERT_PATH, certExists, deleteCertAndKey, KEY_PATH, SSL_PATH } from './tls.js'

const debug = Debug.extend('registration')

const FIVE_DAYS_MS = 5 * 24 * 60 * 60 * 1000

export async function register (initial) {
  const body = {
    nodeId,
    version: NODE_VERSION,
    filWalletAddress: FIL_WALLET_ADDRESS,
    operatorEmail: NODE_OPERATOR_EMAIL,
    memoryStats: await getMemoryStats(),
    diskStats: await getDiskStats(),
    cpuStats: await getCPUStats(),
    nicStats: await getNICStats()
  }

  if (initial) {
    const speedtest = {}
    if (NODE_VERSION !== DEV_VERSION) {
      speedtest.speedtest = await getSpeedtest()
    }
    Object.assign(body, speedtest)
  }

  const registerOptions = postOptions(body)

  // If cert is not yet in the volume, register
  if (!certExists) {
    const sslExist = await fsPromises.stat(SSL_PATH).catch(_ => false)

    if (!sslExist) {
      debug('Creating SSL folder')
      await fsPromises.mkdir(SSL_PATH, { recursive: true })
    }

    debug('Registering with orchestrator, requesting new TLS cert... (this could take up to 20 mins)')
    try {
      const response = await fetch(`${ORCHESTRATOR_URL}/register`, registerOptions)
      const body = await response.json()
      const { cert, key } = body

      if (!cert || !key) {
        debug('Received status %d with %o', response.status, body)
        throw new Error(body?.error || 'Empty cert or key received')
      }

      debug('TLS cert and key received, persisting to shared volume...')

      await Promise.all([
        fsPromises.writeFile(CERT_PATH, cert),
        fsPromises.writeFile(KEY_PATH, key)
      ])

      debug('Successful registration, restarting container...')

      process.exit()
    } catch (e) {
      debug('Failed registration %o', e)
      process.exit(1)
    }
  } else {
    if (initial) {
      const certBuffer = await fsPromises.readFile(CERT_PATH)

      if (certBuffer.toString().split('BEGIN').length === 2) {
        debug('Certificate does not have CA bundled, deleting and rebooting...')
        await deleteCertAndKey()
        process.exit()
      }

      const cert = new X509Certificate(certBuffer)

      const validTo = Date.parse(cert.validTo)

      if (Date.now() > (validTo - FIVE_DAYS_MS)) {
        debug('Certificate is soon to expire, deleting and rebooting...')
        await deleteCertAndKey()
        process.exit()
      } else {
        debug(`Certificate is valid until ${cert.validTo}`)
      }
    }

    debug('Re-registering with orchestrator...')

    try {
      const { token } = await fetch(`${ORCHESTRATOR_URL}/register?ssl=done`, registerOptions).then(res => res.json())

      updateNodeToken(token)

      debug('Successful re-registration, updated token')
    } catch (e) {
      debug('Failed re-registration %s', e.message)
      if (initial) {
        process.exit(1)
      }
    }
  }
  setTimeout(register, (SATURN_NETWORK === 'local' ? 1 : Math.random() * 2 + 4) * 60 * 1000)
}

export async function deregister () {
  debug('De-registering from orchestrator')
  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort()
  }, 30_000)

  try {
    await fetch(`${ORCHESTRATOR_URL}/deregister`, { ...postOptions({ nodeId }), signal: controller.signal })
    debug('De-registered successfully')
  } catch (err) {
    debug(err)
  } finally {
    clearTimeout(timeout)
  }
}

export const addRegisterCheckRoute = (app) => app.get('/register-check', (req, res) => {
  const ip = req.ip.replace('::ffff:', '')
  const { nodeId: receivedNodeId } = req.query
  if (receivedNodeId !== nodeId) {
    debug.extend('registration-check')(`Check failed, nodeId mismatch. Received: ${receivedNodeId} from IP ${ip}`)
    return res.sendStatus(403)
  }
  debug.extend('registration-check')('Successful')
  res.sendStatus(200)
})

function postOptions (body) {
  return {
    method: 'post', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }
  }
}