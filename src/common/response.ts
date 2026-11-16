export type ResponseBody<T> = {
  resultCode: number;
  resultMessage: string;
  success: boolean;
  data?: T | null;
  total?: number;
  rows?: T[];
};

export type ResponseResult<T> = ResponseBody<T>;

type ResponseOptions<T> = {
  code?: number;
  message?: string;
  data?: T | null;
};

const responseData = {
  success<T>({
    code = 1,
    message = '成功',
    data = null,
  }: ResponseOptions<T> = {}): ResponseResult<T> {
    return { resultCode: code, resultMessage: message, success: true, data };
  },

  error<T>({ code = 0, message = '失败', data }: ResponseOptions<T> = {}): ResponseResult<T> {
    return { resultCode: code, resultMessage: message, success: false, data };
  },

  getSuccessByData<T>(data: T | null = null): ResponseResult<T> {
    return responseData.success({ data });
  },

  getErrorByCodeMsg<T>(code = 0, message = '失败'): ResponseResult<T> {
    return responseData.error({ code, message });
  },

  pagination<T>({
    rows,
    total,
    message = '成功',
    data = null,
  }: {
    rows: T[];
    total: number;
    message?: string;
    data?: unknown;
  }) {
    return { resultCode: 1, resultMessage: message, success: true, data, total, rows };
  },
};

export default responseData;
