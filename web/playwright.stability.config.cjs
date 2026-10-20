const {defineConfig,devices}=require('@playwright/test');
module.exports=defineConfig({
 testDir:'../test/browser',testMatch:'stability.spec.cjs',timeout:60000,workers:1,retries:process.env.CI?1:0,reporter:[['list']],
 outputDir:'../test-results/stability-browser',
 use:{baseURL:'http://127.0.0.1:47840',trace:'retain-on-failure',screenshot:'only-on-failure'},
 projects:[{name:'desktop',use:{...devices['Desktop Chrome'],viewport:{width:1440,height:1000}}},{name:'phone',use:{...devices['Desktop Chrome'],viewport:{width:390,height:844},isMobile:true,hasTouch:true}}],
 webServer:{command:'node ../test/helpers/web-demo.cjs',url:'http://127.0.0.1:47840/healthz',timeout:90000,reuseExistingServer:false,env:{WEB_DEMO_WORKSPACE:'1',WEB_RELEASE_BACKUP_GATE:''}},
});
