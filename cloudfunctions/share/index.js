const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const crypto = require('crypto');

const ok = (data) => ({ code: 0, data, message: 'ok' });
const fail = (code, message) => ({ code, data: null, message });

/**
 * 生成带邀请参数的小程序码
 *
 * scene 里带上邀请人 openid，新用户扫码进入后 app.js 解析 query.inv 写入 users.inviteBy，
 * 这是自建好友关系与分享归因的基础（微信的关系链能力已收紧，只能自建）。
 *
 * scene 最长 32 字符，openid 是 28 位，用 'i' 作键刚好放得下。
 */
async function handleQrcode(payload) {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return fail(401, '未登录');

  const page = payload.page || 'pages/index/index';
  const scene = 'i' + OPENID;

  try {
    let result;
    try {
      result = await cloud.openapi.wxacode.getUnlimited({
        scene,
        page,
        width: 280,
        autoColor: false,
        lineColor: { r: 0, g: 102, b: 204 },
        isHyaline: false
      });
    } catch (e) {
      // 41030 invalid page：小程序未正式发布时 page 参数会被微信拒绝。
      // 回退空串（默认跳主页，与 pages/index/index 等价）；正式发布后走正常分支。
      if (String(e.errCode || '') === '41030' || String(e.errMsg || '').indexOf('invalid page') >= 0) {
        console.warn('[share] getUnlimited page rejected, fallback to empty page');
        result = await cloud.openapi.wxacode.getUnlimited({
          scene,
          page: '',
          width: 280,
          autoColor: false,
          lineColor: { r: 0, g: 102, b: 204 },
          isHyaline: false
        });
      } else {
        throw e;
      }
    }

    const hash = crypto.createHash('md5').update(scene + page).digest('hex').slice(0, 12);
    const cloudPath = `qrcode/${hash}.png`;

    // 注意：这里必须每次重新 uploadFile 并返回 upload.fileID（完整 cloud:// ID）。
    // 不能用相对路径 qrcode/xxx.png 当 fileID 返回——客户端 wx.cloud.getTempFileURL
    // 只认完整 cloud:// 文件 ID，相对路径会导致海报图片加载失败。
    const upload = await cloud.uploadFile({
      cloudPath,
      fileContent: result.buffer
    });

    return ok({ fileID: upload.fileID, cached: false });
  } catch (err) {
    console.error('[share] wxacode failed', err);
    return fail(500, '小程序码生成失败');
  }
}

exports.main = async (event) => {
  const { action, payload = {} } = event;
  try {
    switch (action) {
      case 'qrcode':
        return await handleQrcode(payload);
      default:
        return fail(404, '未知操作: ' + action);
    }
  } catch (err) {
    console.error('[share] error', action, err);
    return fail(500, err.message || '服务异常');
  }
};
