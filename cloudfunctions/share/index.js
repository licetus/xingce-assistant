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
    const result = await cloud.openapi.wxacode.getUnlimited({
      scene,
      page,
      width: 280,
      autoColor: false,
      lineColor: { r: 43, g: 108, b: 246 },
      isHyaline: false
    });

    const hash = crypto.createHash('md5').update(scene + page).digest('hex').slice(0, 12);
    const cloudPath = `qrcode/${hash}.png`;

    // 小程序码内容只与 openid 有关，重复生成直接复用已上传的文件，省存储也省调用
    const exist = await cloud.getTempFileURL({ fileList: [cloudPath] }).catch(() => null);
    if (exist && exist.fileList && exist.fileList[0] && exist.fileList[0].status === 0) {
      return ok({ fileID: cloudPath, cached: true });
    }

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
