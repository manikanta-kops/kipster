import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createEmbeddingProvider } from '../dist/index.js'

test('Ollama posts model and original text with proxy paths and optional bearer token', async () => {
  const received=[]
  const server=createServer(async (request,response) => {
    let body=''; for await (const part of request) body+=part
    received.push({path:request.url,authorization:request.headers.authorization,body:JSON.parse(body)})
    response.writeHead(200,{'content-type':'application/json'})
    response.end(JSON.stringify({embeddings:[[1,0,0],[0,1,0]]}))
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  process.env.KIPSTER_EMBED_TEST_TOKEN='private-token'
  try {
    for (const path of ['', '/', '/proxy', '/proxy/']) {
      const provider=createEmbeddingProvider({endpoint:`http://127.0.0.1:${server.address().port}${path}`,model:'model with spaces',apiKeyEnv:'KIPSTER_EMBED_TEST_TOKEN'})
      assert.equal(provider.id,'ollama'); assert.equal(provider.contractMajor,1); assert.equal(provider.model,'model with spaces')
      assert.deepEqual(await provider.embed('hello',new AbortController().signal),[1,0,0])
      assert.deepEqual(received.at(-1),{path:path.startsWith('/proxy')?'/proxy/api/embed':'/api/embed',authorization:'Bearer private-token',body:{model:'model with spaces',input:'hello',truncate:false}})
    }
    const provider=createEmbeddingProvider({endpoint:`http://127.0.0.1:${server.address().port}`,model:'fixture'})
    await provider.embed('no token',new AbortController().signal)
    assert.equal(received.at(-1).authorization,undefined)
    await assert.rejects(provider.embed('aborted',AbortSignal.abort()))
  } finally { delete process.env.KIPSTER_EMBED_TEST_TOKEN; await new Promise(resolve=>server.close(resolve)) }
})

test('Ollama validates its options and reports HTTP errors', async () => {
  const valid={endpoint:'http://127.0.0.1:11434',model:'fixture'}
  for (const options of [null,{}, {...valid,endpoint:'ftp://host'}, {...valid,endpoint:'http://user:pass@host'}, {...valid,endpoint:'http://host/?token=secret'}, {...valid,endpoint:'http://host/#fragment'}, {...valid,model:' '}, {...valid,apiKeyEnv:'env:NAME'}, {...valid,apiKeyEnv:'KIPSTER_ABSENT_EMBEDDING_TOKEN'}]) assert.throws(()=>createEmbeddingProvider(options))
  const server=createServer((request,response)=>{response.writeHead(503);response.end('unavailable')})
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  try { await assert.rejects(createEmbeddingProvider({...valid,endpoint:`http://127.0.0.1:${server.address().port}`}).embed('hello',new AbortController().signal),/HTTP 503/) }
  finally { await new Promise(resolve=>server.close(resolve)) }
})
