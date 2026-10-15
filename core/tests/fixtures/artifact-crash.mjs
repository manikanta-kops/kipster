import {readFile} from 'node:fs/promises'
import {Postgres} from '../../dist/platform/postgres/public.js'
import {Home} from '../../dist/platform/home/public.js'
import {ArtifactService} from '../../dist/modules/artifacts/public.js'

const [url,homePath,proofPath,mode]=process.argv.slice(2)
const {actor,intent,content,attemptId,incarnation,request}=JSON.parse(await readFile(proofPath,'utf8'))
const db=new Postgres(url)
const home=new Home(homePath)
const die=async()=>{process.kill(process.pid,'SIGKILL')}
const service=new ArtifactService(db,home,{afterUploadLink:die,afterAttachLink:die})
if(mode==='complete')await service.upload(actor,intent,(async function*(){yield Buffer.from(content)})())
else if(mode==='partial')await service.upload(actor,intent,(async function*(){yield Buffer.from(content.slice(0,2));process.kill(process.pid,'SIGKILL')})())
else if(mode==='attach')await service.attachFiles(attemptId,incarnation,'crash-attach',request)
