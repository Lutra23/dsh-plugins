// DSH's browser module format. Uses the same official seats as Task Board.
window.__ModuleLoader__.load({
  id:'@dsh-external/dsh-project-forge',
  factory(require){
    const React=require('react'),h=React.createElement
    const PANEL='project-forge',BASE='api/project-forge/view/'
    let openRightEntry=()=>{}
    function Icon({size=16}){
      return h('span',{role:'button',tabIndex:0,title:'施工图',onClick:()=>openRightEntry(),onKeyDown:e=>{if(e.key==='Enter'||e.key===' ')openRightEntry()},style:{display:'inline-flex',cursor:'pointer'}},
        h('svg',{'data-dsh-panel-entry':PANEL,viewBox:'0 0 16 16',width:size,height:size,fill:'none',stroke:'currentColor',strokeWidth:1.3,'aria-hidden':true},
          h('path',{d:'M3 1.8h7l3 3V14H3z M10 1.8V5h3 M5.4 7.2h5.2 M5.4 9.5h5.2 M5.4 11.8h3'})))
    }
    function GuideIcon({size=22,className}){
      return h('svg',{className,viewBox:'0 0 16 16',width:size,height:size,fill:'none',stroke:'currentColor',strokeWidth:1.3,'aria-hidden':true},
        h('path',{d:'M3 1.8h7l3 3V14H3z M10 1.8V5h3 M5.4 7.2h5.2 M5.4 9.5h5.2 M5.4 11.8h3'}))
    }
    function Panel(){
      const ref=React.useRef(null)
      React.useEffect(()=>{
        const sync=()=>{try{
          const doc=ref.current?.contentDocument;if(!doc)return
          const styles=getComputedStyle(document.documentElement)
          const map={'--ink':'--dsw-alias-label-primary','--muted':'--dsw-alias-label-secondary','--line':'--dsw-alias-border-l2','--accent':'--dsw-alias-link-primary','--panel':'--dsw-alias-bg-layer-1','--bg':'--dsw-alias-bg-layer-2'}
          for(const [target,source]of Object.entries(map)){const value=styles.getPropertyValue(source).trim();if(value)doc.documentElement.style.setProperty(target,value)}
          doc.documentElement.style.colorScheme=getComputedStyle(document.documentElement).colorScheme
        }catch{}}
        const frame=ref.current;frame?.addEventListener('load',sync)
        const observer=new MutationObserver(sync);observer.observe(document.documentElement,{attributes:true,attributeFilter:['class','style','data-theme']})
        sync();return()=>{frame?.removeEventListener('load',sync);observer.disconnect()}
      },[])
      return h('div',{'data-dsh-plugin':'project-forge','data-dsh-forge-view':'',style:{width:'100%',height:'100%',minHeight:0,display:'flex',overflow:'hidden'}},
        h('iframe',{ref,title:'施工图与工程管理',src:new URL(BASE+'page',document.baseURI).href,sandbox:'allow-scripts allow-same-origin allow-forms allow-modals allow-popups',style:{border:0,width:'100%',height:'100%',flex:'1 1 auto',background:'transparent'}}))
    }
    function Title(){return h('span',{'data-dsh-plugin':'project-forge',style:{display:'inline-flex',alignItems:'center',gap:'0.35em'}},'施工图')}
    function apply(ctx){
      ctx.slots.inject('sidebar.panellist',()=>ctx.slots.register({name:'sidebar.panellist',id:PANEL,order:25,label:()=> '施工图'},Icon))
      // 右侧栏标签的真链路（照官方 ui-plan 实现抄）：sidebarRightTabs.register 登记类型 → openResource 打开 → 座位画出来。
      // 座位按 definition.id 匹配（sidebar-right L1285: entryKey = definition?.id ?? tab.kind），故三处统一用 PANEL。
      const KIND='project-forge',ADDR='dsh-resource://project-forge/board'
      // 右侧栏「开始」页的入口胶囊：官方 files/browser 同款，条目点击由 sidebar-right 直接 openTab(kind)。
      ctx.effect(()=>ctx.sidebarRightTabs.register({id:PANEL,kind:KIND,patterns:['dsh-resource://project-forge/**'],priority:'extension',canOpen:address=>address===ADDR,title:()=> '施工图',
        guide:[{id:'board',order:40,title:()=> '施工图',description:()=> '工程待办、报告与差异',icon:GuideIcon}]}),'forge: right tab type')
      ctx.effect(()=>ctx.slots.inject('sidebar.right.pane.tab',()=>ctx.slots.register({name:'sidebar.right.pane.tab',key:PANEL},Panel)),'forge: right pane body')
      ctx.effect(()=>ctx.slots.inject('sidebar.right.pane.tab.title',()=>ctx.slots.register({name:'sidebar.right.pane.tab.title',key:PANEL},Title)),'forge: right pane title')
      ctx.slots.inject('main',()=>ctx.slots.register({name:'main',key:PANEL},Panel))
      // 侧边栏图标与工具动作都打开右侧栏标签，而不是把对话区整个换掉。
      const openRight=()=>{try{ctx.sidebarRight.openResource(ADDR)}catch(error){console.warn('[forge] 右侧栏打开失败：'+error.message)}}
      openRightEntry=openRight
      // 不再加载即弹开：保留「开始」页的胶囊入口，点一下才开，避免刷新后指南页被标签顶掉。
      ctx.effect(()=>()=>{openRightEntry=()=>{}},'forge: release right tab entry')
      // The tool's open action selects the same native panel, without a desktop launcher.
      ctx.effect(()=>{
        let closed=false,busy=false,last=0
        const check=async()=>{if(closed||busy||document.hidden)return;busy=true;try{const r=await fetch(new URL(BASE+'entry',document.baseURI),{cache:'no-store'});if(!r.ok)return;const v=await r.json();if(!closed&&Number.isSafeInteger(v.openRevision)&&v.openRevision>last){last=v.openRevision;ctx.layout.selectPanel(PANEL)}}catch{}finally{busy=false}}
        const timer=setInterval(check,2500);void check();return()=>{closed=true;clearInterval(timer)}
      },'forge: panel navigation')
    }
    return {inject:['slots','layout','sidebarRight','sidebarRightTabs'],apply}
  }
})
